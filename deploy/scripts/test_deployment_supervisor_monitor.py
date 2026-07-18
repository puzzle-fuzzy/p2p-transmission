from __future__ import annotations

import io
import json
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from deployment_supervisor import monitor, security, state
from deployment_supervisor_test_support import (
    CONTROL_PLANE_SHA256,
    OPERATION_ID,
    VERSION,
    DummyLock,
    SupervisorTestCase,
)


class DeploymentSupervisorMonitorTests(SupervisorTestCase):
    def test_wait_distinguishes_missing_dead_timeout_and_invalid_state(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        stderr = io.StringIO()
        with (
            patch.object(monitor, 'operation_is_active', return_value=False),
            redirect_stderr(stderr),
        ):
            self.assertEqual(
                monitor.wait_for_worker(
                    OPERATION_ID, VERSION, CONTROL_PLANE_SHA256, timeout=0
                ),
                state.WAIT_STATE_MISSING,
            )

        security.atomic_write_json(
            paths.launch_state,
            state.launch_payload(paths, VERSION, CONTROL_PLANE_SHA256),
        )
        self.write_owned(paths.pid, '4242\n')
        with (
            patch.object(monitor, 'operation_is_active', return_value=False),
            redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(
                monitor.wait_for_worker(
                    OPERATION_ID, VERSION, CONTROL_PLANE_SHA256, timeout=0
                ),
                state.WAIT_DEPLOY_FAILED,
            )

        with (
            patch.object(monitor, 'operation_is_active', return_value=True),
            redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(
                monitor.wait_for_worker(
                    OPERATION_ID, VERSION, CONTROL_PLANE_SHA256, timeout=0
                ),
                state.WAIT_TIMEOUT,
            )

        security.atomic_write_json(paths.status, {**self.valid_status(), 'finished': False})
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(
                monitor.wait_for_worker(
                    OPERATION_ID, VERSION, CONTROL_PLANE_SHA256, timeout=0
                ),
                state.WAIT_STATE_INVALID,
            )

    def test_wait_outputs_success_and_failed_status(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        security.atomic_write_json(
            paths.launch_state,
            state.launch_payload(paths, VERSION, CONTROL_PLANE_SHA256),
        )
        for exit_code, expected in ((0, 0), (17, state.WAIT_DEPLOY_FAILED)):
            with self.subTest(exit_code=exit_code):
                security.atomic_write_json(paths.status, self.valid_status(exit_code=exit_code))
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    result = monitor.wait_for_worker(
                        OPERATION_ID,
                        VERSION,
                        CONTROL_PLANE_SHA256,
                        timeout=0,
                    )
                self.assertEqual(result, expected)
                self.assertEqual(json.loads(stdout.getvalue())['exit_code'], exit_code)

    def test_wait_fails_closed_when_bound_version_differs(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        security.atomic_write_json(
            paths.launch_state,
            state.launch_payload(paths, VERSION, CONTROL_PLANE_SHA256),
        )
        security.atomic_write_json(paths.status, self.valid_status())
        with self.assertRaises(state.SupervisorError):
            state.validate_worker_status(
                self.valid_status(), paths, '2.0.1-other', CONTROL_PLANE_SHA256
            )
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(
                monitor.wait_for_worker(
                    OPERATION_ID,
                    '2.0.1-other',
                    CONTROL_PLANE_SHA256,
                    timeout=0,
                ),
                state.WAIT_STATE_INVALID,
            )

    def test_wait_fails_closed_when_bound_control_plane_differs(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        security.atomic_write_json(
            paths.launch_state,
            state.launch_payload(paths, VERSION, CONTROL_PLANE_SHA256),
        )
        security.atomic_write_json(paths.status, self.valid_status())
        other_digest = 'c' * 64
        with self.assertRaises(state.SupervisorError):
            state.validate_worker_status(
                self.valid_status(), paths, VERSION, other_digest
            )
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(
                monitor.wait_for_worker(
                    OPERATION_ID,
                    VERSION,
                    other_digest,
                    timeout=0,
                ),
                state.WAIT_STATE_INVALID,
            )

    def test_cleanup_refuses_to_overlap_a_running_worker(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        security.atomic_write_json(
            paths.launch_state,
            state.launch_payload(paths, VERSION, CONTROL_PLANE_SHA256),
        )
        self.write_owned(paths.pid, '4242\n')
        self.write_owned(paths.log)
        with (
            patch.object(
                security,
                'acquire_operation_lock',
                side_effect=state.LockBusy('worker owns operation lock'),
            ),
            redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(
                monitor.cleanup_operation(
                    OPERATION_ID, VERSION, CONTROL_PLANE_SHA256
                ),
                state.CLEANUP_WORKER_RUNNING,
            )
        self.assertTrue(paths.log.exists())

    def test_cleanup_refuses_when_any_worker_holds_the_global_lock(self) -> None:
        operation_lock = DummyLock()
        with (
            patch.object(
                security,
                'acquire_operation_lock',
                return_value=operation_lock,
            ),
            patch.object(
                security,
                'acquire_global_lock',
                side_effect=state.LockBusy('busy'),
            ),
            redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(
                monitor.cleanup_operation(
                    OPERATION_ID, VERSION, CONTROL_PLANE_SHA256
                ),
                state.CLEANUP_WORKER_RUNNING,
            )
        self.assertTrue(operation_lock.closed)

    def test_unstarted_uploaded_artifacts_fail_wait_and_are_safely_cleanable(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        artifacts = (
            paths.supervisor,
            paths.source_archive,
            paths.image_archive,
            paths.retired_files,
        )
        for artifact in artifacts:
            self.write_owned(artifact)
        unrelated = self.root / 'unrelated'
        self.write_owned(unrelated)

        with (
            patch.object(monitor, 'operation_is_active', return_value=False),
            redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(
                monitor.wait_for_worker(
                    OPERATION_ID, VERSION, CONTROL_PLANE_SHA256, timeout=0
                ),
                state.WAIT_DEPLOY_FAILED,
            )

        operation_lock = DummyLock()
        global_lock = DummyLock()
        with (
            patch.object(
                security,
                'acquire_operation_lock',
                return_value=operation_lock,
            ),
            patch.object(security, 'acquire_global_lock', return_value=global_lock),
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(
                monitor.cleanup_operation(
                    OPERATION_ID, VERSION, CONTROL_PLANE_SHA256
                ),
                0,
            )

        self.assertTrue(all(not artifact.exists() for artifact in artifacts))
        self.assertTrue(unrelated.exists())
        self.assertTrue(operation_lock.closed)
        self.assertTrue(global_lock.closed)

    def test_unbound_worker_state_stops_cleanup_before_any_deletion(self) -> None:
        for marker, operation_id in zip(
            ('status', 'pid', 'log'),
            ('b' * 40, 'c' * 40, 'd' * 40),
        ):
            with self.subTest(marker=marker):
                paths = state.operation_paths(operation_id)
                artifacts = (
                    paths.supervisor,
                    paths.source_archive,
                    paths.image_archive,
                    paths.retired_files,
                )
                for artifact in artifacts:
                    self.write_owned(artifact)
                worker_state = getattr(paths, marker)
                self.write_owned(worker_state)
                operation_lock = DummyLock()
                global_lock = DummyLock()

                with (
                    patch.object(
                        security,
                        'acquire_operation_lock',
                        return_value=operation_lock,
                    ),
                    patch.object(
                        security,
                        'acquire_global_lock',
                        return_value=global_lock,
                    ),
                    self.assertRaises(state.SupervisorError),
                ):
                    monitor.cleanup_operation(
                        operation_id, VERSION, CONTROL_PLANE_SHA256
                    )

                self.assertTrue(all(artifact.exists() for artifact in artifacts))
                self.assertTrue(worker_state.exists())
                self.assertTrue(operation_lock.closed)
                self.assertTrue(global_lock.closed)

    def test_partial_claim_without_worker_state_is_failed_and_cleanable(self) -> None:
        paths = state.operation_paths('e' * 40)
        fixed_files = (
            paths.launch_state,
            paths.supervisor,
            paths.source_archive,
            paths.image_archive,
            paths.retired_files,
        )
        self.write_owned(paths.launch_state, '{')
        for artifact in fixed_files[1:]:
            self.write_owned(artifact)

        with (
            patch.object(monitor, 'operation_is_active', return_value=False),
            redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(
                monitor.wait_for_worker(
                    paths.operation_id, VERSION, CONTROL_PLANE_SHA256, timeout=0
                ),
                state.WAIT_DEPLOY_FAILED,
            )

        with (
            patch.object(
                security,
                'acquire_operation_lock',
                return_value=DummyLock(),
            ),
            patch.object(security, 'acquire_global_lock', return_value=DummyLock()),
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(
                monitor.cleanup_operation(
                    paths.operation_id, VERSION, CONTROL_PLANE_SHA256
                ),
                0,
            )
        self.assertTrue(all(not target.exists() for target in fixed_files))

    def test_partial_claim_with_worker_state_is_invalid_and_not_cleaned(self) -> None:
        for marker, operation_id in zip(
            ('status', 'pid', 'log'),
            ('f' * 40, '0' * 40, '1' * 40),
        ):
            with self.subTest(marker=marker):
                paths = state.operation_paths(operation_id)
                fixed_files = (
                    paths.launch_state,
                    paths.supervisor,
                    paths.source_archive,
                    paths.image_archive,
                    paths.retired_files,
                )
                self.write_owned(paths.launch_state, '{')
                for artifact in fixed_files[1:]:
                    self.write_owned(artifact)
                worker_state = getattr(paths, marker)
                self.write_owned(worker_state)

                with (
                    patch.object(monitor, 'operation_is_active', return_value=False),
                    redirect_stdout(io.StringIO()),
                    redirect_stderr(io.StringIO()),
                ):
                    self.assertEqual(
                        monitor.wait_for_worker(
                            operation_id, VERSION, CONTROL_PLANE_SHA256, timeout=0
                        ),
                        state.WAIT_STATE_INVALID,
                    )

                with (
                    patch.object(
                        security,
                        'acquire_operation_lock',
                        return_value=DummyLock(),
                    ),
                    patch.object(
                        security,
                        'acquire_global_lock',
                        return_value=DummyLock(),
                    ),
                    self.assertRaises(state.SupervisorError),
                ):
                    monitor.cleanup_operation(
                        operation_id, VERSION, CONTROL_PLANE_SHA256
                    )
                self.assertTrue(all(target.exists() for target in fixed_files))
                self.assertTrue(worker_state.exists())

    def test_cleanup_fails_closed_on_version_mismatch(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        security.atomic_write_json(
            paths.launch_state,
            state.launch_payload(paths, VERSION, CONTROL_PLANE_SHA256),
        )
        lock = DummyLock()
        operation_lock = DummyLock()
        with (
            patch.object(
                security,
                'acquire_operation_lock',
                return_value=operation_lock,
            ),
            patch.object(security, 'acquire_global_lock', return_value=lock),
            self.assertRaises(state.SupervisorError),
        ):
            monitor.cleanup_operation(
                OPERATION_ID, '2.0.1-other', CONTROL_PLANE_SHA256
            )
        self.assertTrue(paths.launch_state.exists())
        self.assertTrue(lock.closed)
        self.assertTrue(operation_lock.closed)

    def test_cleanup_removes_only_this_operations_fixed_files(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        other = self.root / 'unrelated'
        self.write_owned(other)
        for target in paths.cleanup_targets():
            if target in (paths.launch_state, paths.status):
                continue
            self.write_owned(target)
        security.atomic_write_json(
            paths.launch_state,
            state.launch_payload(paths, VERSION, CONTROL_PLANE_SHA256),
        )
        security.atomic_write_json(paths.status, self.valid_status())
        self.write_owned(paths.pid, '9999\n')
        lock = DummyLock()
        operation_lock = DummyLock()
        with (
            patch.object(
                security,
                'acquire_operation_lock',
                return_value=operation_lock,
            ),
            patch.object(security, 'acquire_global_lock', return_value=lock),
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(
                monitor.cleanup_operation(
                    OPERATION_ID, VERSION, CONTROL_PLANE_SHA256
                ),
                0,
            )
        self.assertTrue(all(not target.exists() for target in paths.cleanup_targets()))
        self.assertTrue(other.exists())
        self.assertTrue(lock.closed)
        self.assertTrue(operation_lock.closed)

    def test_cleanup_rejects_symlinks_without_deleting_their_target(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        security.atomic_write_json(
            paths.launch_state,
            state.launch_payload(paths, VERSION, CONTROL_PLANE_SHA256),
        )
        victim = self.root / 'victim'
        self.write_owned(victim, 'keep')
        try:
            paths.log.symlink_to(victim)
        except OSError as error:
            self.skipTest(f'symlinks are unavailable: {error}')
        lock = DummyLock()
        operation_lock = DummyLock()
        with (
            patch.object(
                security,
                'acquire_operation_lock',
                return_value=operation_lock,
            ),
            patch.object(security, 'acquire_global_lock', return_value=lock),
            self.assertRaises(state.SupervisorError),
        ):
            monitor.cleanup_operation(OPERATION_ID, VERSION, CONTROL_PLANE_SHA256)
        self.assertEqual(victim.read_text(encoding='utf-8'), 'keep')


if __name__ == '__main__':
    import unittest

    unittest.main()
