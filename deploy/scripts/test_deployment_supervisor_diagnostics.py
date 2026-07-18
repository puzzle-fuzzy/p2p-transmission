from __future__ import annotations

import io
import os
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from deployment_supervisor import diagnostics, security, state
from deployment_supervisor_test_support import (
    CONTROL_PLANE_SHA256,
    OPERATION_ID,
    VERSION,
    DummyLock,
    SupervisorTestCase,
)


class DeploymentSupervisorDiagnosticsTests(SupervisorTestCase):
    def bind_failed_worker(self, log: str = 'compose failed\n') -> state.OperationPaths:
        paths = state.operation_paths(OPERATION_ID)
        security.atomic_write_json(
            paths.launch_state,
            state.launch_payload(paths, VERSION, CONTROL_PLANE_SHA256),
        )
        security.atomic_write_json(paths.status, self.valid_status(exit_code=17))
        self.write_owned(paths.log, log)
        return paths

    def test_failure_log_is_redacted_inert_bounded_and_bound_to_operation(self) -> None:
        paths = self.bind_failed_worker(
            ('safe context\n' * 9000)
            + '\x1b[31mcompose failed\x1b[0m\n'
            + 'debug environment: UNEXPECTED_NAME=do-not-print\n'
            + 'request https://alice:hunter2@example.test/path\n'
            + 'Authorization: Bearer bearer-must-not-print\n'
            + '-----BEGIN PRIVATE KEY-----\nprivate-key-must-not-print\n'
            + '-----END PRIVATE KEY-----\n'
            + '::error::not a workflow command\n'
            + 'root cause: image archive is corrupt\n'
        )
        lock = DummyLock()
        stdout = io.StringIO()
        with (
            patch.object(security, 'acquire_operation_lock', return_value=lock),
            redirect_stdout(stdout),
        ):
            self.assertEqual(
                diagnostics.report_failure_log(OPERATION_ID, VERSION, CONTROL_PLANE_SHA256),
                0,
            )
        output = stdout.getvalue()
        self.assertTrue(lock.closed)
        self.assertIn('root cause: image archive is corrupt', output)
        self.assertNotIn('do-not-print', output)
        self.assertNotIn('hunter2', output)
        self.assertNotIn('bearer-must-not-print', output)
        self.assertNotIn('private-key-must-not-print', output)
        self.assertIn('[REDACTED sensitive line]', output)
        self.assertNotIn('\x1b', output)
        self.assertNotIn('\n::error::', output)
        self.assertLessEqual(
            len(output.encode('utf-8')),
            state.MAX_DIAGNOSTIC_LOG_BYTES + 64,
        )
        self.assertEqual(paths.log.parent, state.TMP_ROOT)

    def test_failure_log_rejects_success_hardlink_owner_and_oversize(self) -> None:
        paths = self.bind_failed_worker()
        lock = DummyLock()
        security.atomic_write_json(paths.status, self.valid_status(exit_code=0))
        with (
            patch.object(security, 'acquire_operation_lock', return_value=lock),
            self.assertRaisesRegex(state.SupervisorError, 'successful worker'),
        ):
            diagnostics.report_failure_log(OPERATION_ID, VERSION, CONTROL_PLANE_SHA256)
        self.assertTrue(lock.closed)

        security.atomic_write_json(paths.status, self.valid_status(exit_code=17))
        self.write_owned(paths.log, 'hard linked log')
        os.link(paths.log, self.root / 'second-log-link')
        with (
            patch.object(security, 'acquire_operation_lock', return_value=DummyLock()),
            self.assertRaisesRegex(state.SupervisorError, 'exactly one hard link'),
        ):
            diagnostics.report_failure_log(OPERATION_ID, VERSION, CONTROL_PLANE_SHA256)

        (self.root / 'second-log-link').unlink()
        owner = paths.log.stat().st_uid
        with (
            patch.object(
                security,
                '_current_uid',
                side_effect=[owner, owner, owner + 1],
            ),
            patch.object(security, 'acquire_operation_lock', return_value=DummyLock()),
            self.assertRaisesRegex(state.SupervisorError, 'not owned'),
        ):
            diagnostics.report_failure_log(OPERATION_ID, VERSION, CONTROL_PLANE_SHA256)

        paths.log.write_bytes(b'x' * (state.MAX_WORKER_LOG_BYTES + 1))
        with (
            patch.object(security, 'acquire_operation_lock', return_value=DummyLock()),
            self.assertRaisesRegex(state.SupervisorError, 'size limit'),
        ):
            diagnostics.report_failure_log(OPERATION_ID, VERSION, CONTROL_PLANE_SHA256)

    def test_failure_log_rejects_a_symlink_without_reading_its_target(self) -> None:
        paths = self.bind_failed_worker()
        victim = self.root / 'victim'
        self.write_owned(victim, 'must remain private')
        paths.log.unlink()
        try:
            paths.log.symlink_to(victim)
        except OSError as error:
            self.skipTest(f'symlinks are unavailable: {error}')
        stdout = io.StringIO()
        with (
            patch.object(security, 'acquire_operation_lock', return_value=DummyLock()),
            redirect_stdout(stdout),
            self.assertRaises(state.SupervisorError),
        ):
            diagnostics.report_failure_log(OPERATION_ID, VERSION, CONTROL_PLANE_SHA256)
        self.assertNotIn('must remain private', stdout.getvalue())

    @unittest.skipUnless(os.name == 'posix', 'exact mode enforcement is POSIX-only')
    def test_failure_log_rejects_a_non_private_mode(self) -> None:
        paths = self.bind_failed_worker()
        paths.log.chmod(0o640)
        with (
            patch.object(security, 'acquire_operation_lock', return_value=DummyLock()),
            self.assertRaisesRegex(state.SupervisorError, '0600'),
        ):
            diagnostics.report_failure_log(OPERATION_ID, VERSION, CONTROL_PLANE_SHA256)

    def test_failure_log_rejects_wrong_binding_and_an_active_worker(self) -> None:
        self.bind_failed_worker()
        with (
            patch.object(security, 'acquire_operation_lock', return_value=DummyLock()),
            self.assertRaisesRegex(state.SupervisorError, 'does not match'),
        ):
            diagnostics.report_failure_log(OPERATION_ID, '2.0.1-other', CONTROL_PLANE_SHA256)
        with (
            patch.object(
                security,
                'acquire_operation_lock',
                side_effect=state.LockBusy('worker is active'),
            ),
            self.assertRaisesRegex(state.LockBusy, 'active'),
        ):
            diagnostics.report_failure_log(OPERATION_ID, VERSION, CONTROL_PLANE_SHA256)


if __name__ == '__main__':
    unittest.main()
