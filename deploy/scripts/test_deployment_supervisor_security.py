from __future__ import annotations

import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from deployment_supervisor import security, state
from deployment_supervisor_test_support import OPERATION_ID, SupervisorTestCase


@unittest.skipUnless(
    os.name == 'posix' and security.fcntl is not None,
    'real deployment lock tests require POSIX flock',
)
class DeploymentSupervisorSecurityTests(SupervisorTestCase):
    def test_exclusive_claim_has_exactly_one_concurrent_winner(self) -> None:
        path = state.operation_paths(OPERATION_ID).launch_state
        barrier = threading.Barrier(2)

        def claim(writer: int) -> int | None:
            barrier.wait(timeout=5)
            try:
                security.create_exclusive_json(path, {'writer': writer})
            except state.SupervisorError:
                return None
            return writer

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(claim, range(2)))

        winners = [result for result in results if result is not None]
        self.assertEqual(len(winners), 1)
        self.assertEqual(security.read_json_file(path), {'writer': winners[0]})
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_failed_claim_write_removes_only_its_partial_file(self) -> None:
        path = state.operation_paths(OPERATION_ID).launch_state
        real_fdopen = security.os.fdopen

        class FailingWriter:
            def __init__(self, destination: object) -> None:
                self.destination = destination

            def __enter__(self) -> FailingWriter:
                return self

            def __exit__(self, *args: object) -> None:
                self.destination.close()

            def write(self, payload: bytes) -> None:
                raise OSError('injected write failure')

        def failing_fdopen(descriptor: int, *args: object, **kwargs: object) -> FailingWriter:
            return FailingWriter(real_fdopen(descriptor, *args, **kwargs))

        with (
            patch.object(security.os, 'fdopen', side_effect=failing_fdopen),
            self.assertRaisesRegex(state.SupervisorError, 'injected write failure'),
        ):
            security.create_exclusive_bytes(path, b'partial')

        self.assertFalse(path.exists())
        security.create_exclusive_bytes(path, b'complete')
        self.assertEqual(security.secure_read_bytes(path), b'complete')

    def test_failed_claim_fsync_removes_only_its_partial_file(self) -> None:
        path = state.operation_paths(OPERATION_ID).launch_state
        with (
            patch.object(security.os, 'fsync', side_effect=OSError('injected fsync failure')),
            self.assertRaisesRegex(state.SupervisorError, 'injected fsync failure'),
        ):
            security.create_exclusive_bytes(path, b'partial')

        self.assertFalse(path.exists())
        security.create_exclusive_bytes(path, b'complete')
        self.assertEqual(security.secure_read_bytes(path), b'complete')

    def test_adopted_inherited_duplicate_keeps_the_lock_exclusive(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        parent_lock = security.acquire_operation_lock(paths)
        inherited_descriptor = os.dup(parent_lock.fileno())
        adopted_lock = security.adopt_operation_lock(inherited_descriptor, paths)
        parent_lock.close()

        with self.assertRaises(state.LockBusy):
            security.acquire_operation_lock(paths)

        adopted_lock.close()
        available_lock = security.acquire_operation_lock(paths)
        available_lock.close()

    def test_adopt_rejects_and_closes_an_unlocked_descriptor(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        self.write_owned(paths.operation_lock)
        descriptor = os.open(paths.operation_lock, os.O_RDWR)

        with self.assertRaisesRegex(state.SupervisorError, 'not already held'):
            security.adopt_operation_lock(descriptor, paths)
        with self.assertRaises(OSError):
            os.fstat(descriptor)

    def test_adopt_rejects_a_bad_descriptor_without_masking_the_error(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        self.write_owned(paths.operation_lock)
        descriptor = os.open(paths.operation_lock, os.O_RDWR)
        os.close(descriptor)

        with self.assertRaisesRegex(state.SupervisorError, 'cannot validate'):
            security.adopt_operation_lock(descriptor, paths)

    def test_adopt_rejects_and_closes_an_inode_replaced_descriptor(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        parent_lock = security.acquire_operation_lock(paths)
        inherited_descriptor = os.dup(parent_lock.fileno())
        replacement = self.root / 'replacement-lock'
        self.write_owned(replacement)
        os.replace(replacement, paths.operation_lock)

        with self.assertRaises(state.SupervisorError):
            security.adopt_operation_lock(inherited_descriptor, paths)
        with self.assertRaises(OSError):
            os.fstat(inherited_descriptor)
        parent_lock.close()

    def test_owned_files_reject_hardlinks_and_non_private_modes(self) -> None:
        hardlinked = self.root / 'hardlinked'
        second_link = self.root / 'second-link'
        self.write_owned(hardlinked)
        os.link(hardlinked, second_link)
        with self.assertRaisesRegex(state.SupervisorError, 'exactly one hard link'):
            security.lstat_regular(hardlinked, require_owner=True)

        public = self.root / 'public'
        self.write_owned(public)
        public.chmod(0o640)
        with self.assertRaisesRegex(state.SupervisorError, '0600'):
            security.lstat_regular(public, require_owner=True)


if __name__ == '__main__':
    unittest.main()
