from __future__ import annotations

from deployment_supervisor import state
from deployment_supervisor_test_support import (
    CONTROL_PLANE_SHA256,
    OPERATION_ID,
    VERSION,
    SupervisorTestCase,
)


class DeploymentSupervisorStateTests(SupervisorTestCase):
    def test_operation_id_and_version_validation(self) -> None:
        self.assertEqual(state.require_operation_id(OPERATION_ID), OPERATION_ID)
        for invalid in ('a' * 39, 'A' * 40, '../' + 'a' * 40, 'g' * 40):
            with self.subTest(invalid=invalid), self.assertRaises(state.SupervisorError):
                state.require_operation_id(invalid)
        for invalid in ('', '-release', 'release value', 'x' * 129):
            with self.subTest(invalid=invalid), self.assertRaises(state.SupervisorError):
                state.require_version(invalid)
        self.assertEqual(
            state.require_control_plane_sha256(CONTROL_PLANE_SHA256),
            CONTROL_PLANE_SHA256,
        )
        for invalid in ('b' * 63, 'B' * 64, 'g' * 64, '../' + 'b' * 64):
            with self.subTest(invalid=invalid), self.assertRaises(state.SupervisorError):
                state.require_control_plane_sha256(invalid)

    def test_operation_paths_are_fixed_and_unique_under_tmp(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        self.assertEqual(paths.supervisor.parent, self.root)
        self.assertEqual(
            paths.supervisor.name,
            f'p2p-transmission-deploy-{OPERATION_ID}-supervisor.py',
        )
        self.assertEqual(paths.source_archive.name, f'p2p-transmission-{OPERATION_ID}.tar.gz')
        self.assertEqual(
            paths.image_archive.name,
            f'p2p-transmission-image-{OPERATION_ID}.tar.gz',
        )
        self.assertEqual(
            paths.operation_lock.name,
            f'p2p-transmission-deploy-{OPERATION_ID}-worker.lock',
        )
        self.assertNotIn(paths.operation_lock, paths.cleanup_targets())
        self.assertEqual(len(set(paths.cleanup_targets())), len(paths.cleanup_targets()))
        self.assertTrue(all(path.parent == self.root for path in paths.cleanup_targets()))

    def test_backup_log_accepts_one_exact_backup_path(self) -> None:
        backup_path = (
            '/opt/p2p-transmission/deploy/production/backups/'
            f'control-20260717T123456123456Z-{VERSION}.sqlite3'
        )
        result = state.parse_backup_log(
            f'noise\n{state.BACKUP_READY_PREFIX}{backup_path}\nmore noise\n',
            VERSION,
        )
        self.assertEqual(result.database_backup, backup_path)
        self.assertFalse(result.backup_not_required)

    def test_backup_log_accepts_one_explicit_not_required_line(self) -> None:
        result = state.parse_backup_log(
            f'$ docker compose config\n{state.BACKUP_NOT_REQUIRED_LINE}\n',
            VERSION,
        )
        self.assertIsNone(result.database_backup)
        self.assertTrue(result.backup_not_required)

    def test_backup_log_rejects_missing_duplicate_and_unsafe_outcomes(self) -> None:
        valid_path = (
            '/opt/p2p-transmission/deploy/production/backups/'
            f'control-20260717T123456123456Z-{VERSION}.sqlite3'
        )
        cases = (
            'no backup result\n',
            f'{state.BACKUP_NOT_REQUIRED_LINE}\n{state.BACKUP_NOT_REQUIRED_LINE}\n',
            f'{state.BACKUP_READY_PREFIX}/tmp/control.sqlite3\n',
            (
                f'{state.BACKUP_READY_PREFIX}{valid_path}\n'
                f'{state.BACKUP_NOT_REQUIRED_LINE}\n'
            ),
            f'{state.BACKUP_READY_PREFIX}{valid_path} extra\n',
        )
        for text in cases:
            with self.subTest(text=text), self.assertRaises(state.SupervisorError):
                state.parse_backup_log(text, VERSION)

    def test_failed_status_does_not_require_backup_metadata(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        status = self.valid_status(exit_code=7)
        status['database_backup_not_required'] = False
        self.assertEqual(
            state.validate_worker_status(
                status, paths, VERSION, CONTROL_PLANE_SHA256
            ),
            status,
        )


if __name__ == '__main__':
    import unittest

    unittest.main()
