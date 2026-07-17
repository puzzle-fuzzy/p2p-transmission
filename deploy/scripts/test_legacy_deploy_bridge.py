from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch


SCRIPT = Path(__file__).with_name('legacy-deploy-bridge.py')
SPEC = importlib.util.spec_from_file_location('legacy_deploy_bridge', SCRIPT)
assert SPEC is not None and SPEC.loader is not None
bridge = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bridge
SPEC.loader.exec_module(bridge)

OPERATION_ID = 'a' * 40
VERSION = '2.0.1-aaaaaaaaaaaa'


class DummyLock:
    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


class LegacyDeployBridgeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.patchers = [
            patch.object(bridge, 'TMP_ROOT', self.root),
            patch.object(bridge, 'GLOBAL_LOCK', self.root / 'p2p-transmission-legacy-deploy.lock'),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temporary.cleanup()

    def write_owned(self, path: Path, text: str = 'fixture') -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        os.chmod(path, 0o600)

    def valid_status(
        self, *, exit_code: int = 0, mode: str = bridge.LEGACY_MODE
    ) -> dict[str, object]:
        return {
            'schema': bridge.SCHEMA,
            'operation_id': OPERATION_ID,
            'version': VERSION,
            'mode': mode,
            'exit_code': exit_code,
            'database_backup': None,
            'database_backup_not_required': True,
            'finished': True,
        }

    def test_operation_id_and_version_validation(self) -> None:
        self.assertEqual(bridge.require_operation_id(OPERATION_ID), OPERATION_ID)
        for invalid in ('a' * 39, 'A' * 40, '../' + 'a' * 40, 'g' * 40):
            with self.subTest(invalid=invalid), self.assertRaises(bridge.BridgeError):
                bridge.require_operation_id(invalid)
        for invalid in ('', '-release', 'release value', 'x' * 129):
            with self.subTest(invalid=invalid), self.assertRaises(bridge.BridgeError):
                bridge.require_version(invalid)
        self.assertEqual(bridge.require_mode(bridge.LEGACY_MODE), bridge.LEGACY_MODE)
        self.assertEqual(bridge.require_mode(bridge.V2_MODE), bridge.V2_MODE)
        with self.assertRaises(bridge.BridgeError):
            bridge.require_mode('auto')

    def test_operation_paths_are_fixed_and_unique_under_tmp(self) -> None:
        paths = bridge.operation_paths(OPERATION_ID)
        self.assertEqual(paths.bridge.parent, self.root)
        self.assertEqual(paths.bridge.name, f'p2p-transmission-legacy-{OPERATION_ID}-bridge.py')
        self.assertEqual(paths.source_archive.name, f'p2p-transmission-{OPERATION_ID}.tar.gz')
        self.assertEqual(
            paths.image_archive.name,
            f'p2p-transmission-image-{OPERATION_ID}.tar.gz',
        )
        self.assertEqual(
            paths.retired_files.name,
            f'p2p-transmission-retired-{OPERATION_ID}.json',
        )
        self.assertEqual(len(set(paths.cleanup_targets())), len(paths.cleanup_targets()))
        self.assertTrue(all(path.parent == self.root for path in paths.cleanup_targets()))

    def test_backup_log_accepts_one_exact_backup_path(self) -> None:
        backup_path = (
            '/opt/p2p-transmission/deploy/production/backups/'
            f'control-20260717T123456123456Z-{VERSION}.sqlite3'
        )
        result = bridge.parse_backup_log(
            f'noise\n{bridge.BACKUP_READY_PREFIX}{backup_path}\nmore noise\n',
            VERSION,
        )
        self.assertEqual(result.database_backup, backup_path)
        self.assertFalse(result.backup_not_required)

    def test_snapshot_copies_runtime_files_and_records_all_actual_hashes(self) -> None:
        paths = bridge.operation_paths(OPERATION_ID)
        compose = self.root / 'actual-compose.yml'
        nginx = self.root / 'actual-nginx.conf'
        helper = self.root / 'actual-helper.py'
        wrapper = self.root / 'actual-wrapper'
        for path, content in (
            (compose, 'compose'),
            (nginx, 'nginx'),
            (helper, 'helper'),
            (wrapper, 'wrapper'),
        ):
            self.write_owned(path, content)
        lock = DummyLock()
        with (
            patch.object(bridge, 'PRODUCTION_COMPOSE', compose),
            patch.object(bridge, 'PRODUCTION_NGINX', nginx),
            patch.object(bridge, 'LEGACY_HELPER', helper),
            patch.object(bridge, 'LEGACY_WRAPPER', wrapper),
            patch.object(bridge, 'current_production_release', return_value='2.0.1-previous'),
            patch.object(bridge, 'acquire_global_lock', return_value=lock),
        ):
            payload = bridge.snapshot_payload(paths)

        self.assertEqual(paths.compose_snapshot.read_text(encoding='utf-8'), 'compose')
        self.assertEqual(paths.nginx_snapshot.read_text(encoding='utf-8'), 'nginx')
        self.assertEqual(payload['compose_sha256'], bridge.file_sha256(compose))
        self.assertEqual(payload['nginx_sha256'], bridge.file_sha256(nginx))
        self.assertEqual(payload['helper_sha256'], bridge.file_sha256(helper))
        self.assertEqual(payload['wrapper_sha256'], bridge.file_sha256(wrapper))
        self.assertEqual(payload['mode'], bridge.LEGACY_MODE)
        self.assertEqual(bridge.read_json_file(paths.snapshot_state), payload)
        self.assertTrue(lock.closed)

    def test_backup_log_accepts_one_explicit_not_required_line(self) -> None:
        result = bridge.parse_backup_log(
            f'$ docker compose config\n{bridge.BACKUP_NOT_REQUIRED_LINE}\n',
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
            f'{bridge.BACKUP_NOT_REQUIRED_LINE}\n{bridge.BACKUP_NOT_REQUIRED_LINE}\n',
            f'{bridge.BACKUP_READY_PREFIX}/tmp/control.sqlite3\n',
            f'{bridge.BACKUP_READY_PREFIX}{valid_path}\n{bridge.BACKUP_NOT_REQUIRED_LINE}\n',
            f'{bridge.BACKUP_READY_PREFIX}{valid_path} extra\n',
        )
        for text in cases:
            with self.subTest(text=text), self.assertRaises(bridge.BridgeError):
                bridge.parse_backup_log(text, VERSION)

    def test_wait_distinguishes_missing_dead_timeout_and_invalid_state(self) -> None:
        paths = bridge.operation_paths(OPERATION_ID)
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            self.assertEqual(
                bridge.wait_for_worker(
                    OPERATION_ID, VERSION, bridge.LEGACY_MODE, timeout=0
                ),
                bridge.WAIT_STATE_MISSING,
            )

        bridge.atomic_write_json(
            paths.launch_state,
            bridge.launch_payload(paths, VERSION, bridge.LEGACY_MODE),
        )
        self.write_owned(paths.pid, '4242\n')
        with (
            patch.object(bridge, 'process_is_alive', return_value=False),
            redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(
                bridge.wait_for_worker(
                    OPERATION_ID, VERSION, bridge.LEGACY_MODE, timeout=0
                ),
                bridge.WAIT_PROCESS_DIED,
            )

        with (
            patch.object(bridge, 'process_is_alive', return_value=True),
            redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(
                bridge.wait_for_worker(
                    OPERATION_ID, VERSION, bridge.LEGACY_MODE, timeout=0
                ),
                bridge.WAIT_TIMEOUT,
            )

        bridge.atomic_write_json(paths.status, {**self.valid_status(), 'finished': False})
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(
                bridge.wait_for_worker(
                    OPERATION_ID, VERSION, bridge.LEGACY_MODE, timeout=0
                ),
                bridge.WAIT_STATE_INVALID,
            )

    def test_wait_outputs_success_and_failed_legacy_status(self) -> None:
        paths = bridge.operation_paths(OPERATION_ID)
        bridge.atomic_write_json(
            paths.launch_state,
            bridge.launch_payload(paths, VERSION, bridge.LEGACY_MODE),
        )
        for exit_code, expected in ((0, 0), (17, bridge.WAIT_DEPLOY_FAILED)):
            with self.subTest(exit_code=exit_code):
                bridge.atomic_write_json(paths.status, self.valid_status(exit_code=exit_code))
                stdout = io.StringIO()
                with redirect_stdout(stdout):
                    result = bridge.wait_for_worker(
                        OPERATION_ID,
                        VERSION,
                        bridge.LEGACY_MODE,
                        timeout=0,
                    )
                self.assertEqual(result, expected)
                self.assertEqual(json.loads(stdout.getvalue())['exit_code'], exit_code)

    def test_wait_fails_closed_when_bound_helper_mode_differs(self) -> None:
        paths = bridge.operation_paths(OPERATION_ID)
        bridge.atomic_write_json(
            paths.launch_state,
            bridge.launch_payload(paths, VERSION, bridge.LEGACY_MODE),
        )
        bridge.atomic_write_json(paths.status, self.valid_status())
        with self.assertRaises(bridge.BridgeError):
            bridge.validate_worker_status(
                self.valid_status(), paths, VERSION, bridge.V2_MODE
            )
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(
                bridge.wait_for_worker(OPERATION_ID, VERSION, bridge.V2_MODE, timeout=0),
                bridge.WAIT_STATE_INVALID,
            )

    def test_v2_worker_command_is_the_fixed_stage_invocation(self) -> None:
        paths = bridge.operation_paths(OPERATION_ID)
        self.assertEqual(
            bridge.worker_command(paths, VERSION, bridge.V2_MODE),
            [
                'sudo',
                '-n',
                str(bridge.LEGACY_WRAPPER),
                'stage',
                '--archive',
                str(paths.source_archive),
                '--image-archive',
                str(paths.image_archive),
                '--retired-files',
                str(paths.retired_files),
                '--version',
                VERSION,
            ],
        )

    def test_v2_start_refuses_legacy_snapshot_state(self) -> None:
        paths = bridge.operation_paths(OPERATION_ID)
        for artifact in (paths.source_archive, paths.image_archive, paths.retired_files):
            self.write_owned(artifact)
        self.write_owned(paths.snapshot_state, '{}')
        with self.assertRaises(bridge.BridgeError):
            bridge.validate_mode_prerequisites(paths, bridge.V2_MODE)

    def test_v2_failed_status_does_not_require_legacy_backup_metadata(self) -> None:
        paths = bridge.operation_paths(OPERATION_ID)
        status = self.valid_status(exit_code=7, mode=bridge.V2_MODE)
        status['database_backup_not_required'] = False
        self.assertEqual(
            bridge.validate_worker_status(status, paths, VERSION, bridge.V2_MODE),
            status,
        )

    def test_cross_operation_lock_contention_has_a_nonrollback_wait_code(self) -> None:
        paths = bridge.operation_paths(OPERATION_ID)
        bridge.atomic_write_json(
            paths.launch_state,
            bridge.launch_payload(paths, VERSION, bridge.LEGACY_MODE),
        )
        with (
            patch.object(
                bridge,
                'acquire_global_lock',
                side_effect=bridge.LockBusy('another operation owns the lock'),
            ),
            patch.object(bridge.subprocess, 'run') as deploy,
        ):
            self.assertEqual(
                bridge.run_worker(OPERATION_ID, VERSION, bridge.LEGACY_MODE),
                0,
            )
        deploy.assert_not_called()

        status = bridge.read_json_file(paths.status)
        self.assertEqual(status['exit_code'], bridge.WORKER_LOCKED)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            wait_code = bridge.wait_for_worker(
                OPERATION_ID,
                VERSION,
                bridge.LEGACY_MODE,
                timeout=0,
            )
        self.assertEqual(wait_code, bridge.WAIT_WORKER_LOCKED)
        self.assertNotIn(wait_code, (0, bridge.WAIT_DEPLOY_FAILED))

    def test_worker_uses_only_fixed_sudo_wrapper_command_and_writes_status(self) -> None:
        paths = bridge.operation_paths(OPERATION_ID)
        for artifact in (paths.source_archive, paths.image_archive, paths.retired_files):
            self.write_owned(artifact)
        backup_path = (
            '/opt/p2p-transmission/deploy/production/backups/'
            f'control-20260717T123456123456Z-{VERSION}.sqlite3'
        )

        def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            log = kwargs['stdout']
            assert hasattr(log, 'write')
            log.write(f'{bridge.BACKUP_READY_PREFIX}{backup_path}\n')
            return subprocess.CompletedProcess(command, 0)

        lock = DummyLock()
        bridge.atomic_write_json(
            paths.launch_state,
            bridge.launch_payload(paths, VERSION, bridge.LEGACY_MODE),
        )
        with (
            patch.object(bridge, 'validate_snapshot'),
            patch.object(bridge, 'acquire_global_lock', return_value=lock),
            patch.object(bridge.subprocess, 'run', side_effect=fake_run) as run,
        ):
            self.assertEqual(
                bridge.run_worker(OPERATION_ID, VERSION, bridge.LEGACY_MODE),
                0,
            )

        expected = [
            'sudo',
            '-n',
            str(bridge.LEGACY_WRAPPER),
            '--archive',
            str(paths.source_archive),
            '--image-archive',
            str(paths.image_archive),
            '--retired-files',
            str(paths.retired_files),
            '--version',
            VERSION,
        ]
        self.assertEqual(run.call_args.args[0], expected)
        self.assertTrue(run.call_args.kwargs['close_fds'])
        status = bridge.read_json_file(paths.status)
        self.assertEqual(status['exit_code'], 0)
        self.assertEqual(status['mode'], bridge.LEGACY_MODE)
        self.assertEqual(status['database_backup'], backup_path)
        self.assertFalse(status['database_backup_not_required'])
        self.assertTrue(status['finished'])
        self.assertTrue(lock.closed)

    def test_start_detaches_same_bridge_script(self) -> None:
        paths = bridge.operation_paths(OPERATION_ID)
        self.write_owned(paths.bridge, '# fixture')
        process = Mock(pid=4312)
        with (
            patch.object(bridge, 'bridge_script_path', return_value=paths.bridge),
            patch.object(bridge, 'validate_mode_prerequisites'),
            patch.object(bridge.subprocess, 'Popen', return_value=process) as popen,
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(
                bridge.start_worker(OPERATION_ID, VERSION, bridge.LEGACY_MODE),
                0,
            )
        command = popen.call_args.args[0]
        self.assertEqual(command[1], str(paths.bridge))
        self.assertEqual(command[2], '_worker')
        self.assertEqual(command[-2:], ['--mode', bridge.LEGACY_MODE])
        self.assertTrue(popen.call_args.kwargs['start_new_session'])
        self.assertEqual(bridge.read_pid(paths.pid), process.pid)
        self.assertEqual(
            bridge.read_json_file(paths.launch_state),
            bridge.launch_payload(paths, VERSION, bridge.LEGACY_MODE),
        )

    def test_cleanup_refuses_to_overlap_a_running_worker(self) -> None:
        paths = bridge.operation_paths(OPERATION_ID)
        bridge.atomic_write_json(
            paths.launch_state,
            bridge.launch_payload(paths, VERSION, bridge.LEGACY_MODE),
        )
        self.write_owned(paths.pid, '4242\n')
        self.write_owned(paths.log)
        lock = DummyLock()
        with (
            patch.object(bridge, 'acquire_global_lock', return_value=lock),
            patch.object(bridge, 'process_is_alive', return_value=True),
            redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(
                bridge.cleanup_operation(OPERATION_ID, VERSION, bridge.LEGACY_MODE),
                bridge.CLEANUP_WORKER_RUNNING,
            )
        self.assertTrue(paths.log.exists())
        self.assertTrue(lock.closed)

    def test_cleanup_refuses_when_any_worker_holds_the_global_lock(self) -> None:
        with (
            patch.object(
                bridge,
                'acquire_global_lock',
                side_effect=bridge.LockBusy('busy'),
            ),
            redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(
                bridge.cleanup_operation(OPERATION_ID, VERSION, bridge.LEGACY_MODE),
                bridge.CLEANUP_WORKER_RUNNING,
            )

    def test_cleanup_fails_closed_on_helper_mode_mismatch(self) -> None:
        paths = bridge.operation_paths(OPERATION_ID)
        bridge.atomic_write_json(
            paths.launch_state,
            bridge.launch_payload(paths, VERSION, bridge.LEGACY_MODE),
        )
        lock = DummyLock()
        with (
            patch.object(bridge, 'acquire_global_lock', return_value=lock),
            self.assertRaises(bridge.BridgeError),
        ):
            bridge.cleanup_operation(OPERATION_ID, VERSION, bridge.V2_MODE)
        self.assertTrue(paths.launch_state.exists())
        self.assertTrue(lock.closed)

    def test_cleanup_removes_only_this_operations_fixed_files(self) -> None:
        paths = bridge.operation_paths(OPERATION_ID)
        other = self.root / 'unrelated'
        self.write_owned(other)
        for target in paths.cleanup_targets():
            if target in (paths.launch_state, paths.status):
                continue
            self.write_owned(target)
        bridge.atomic_write_json(
            paths.launch_state,
            bridge.launch_payload(paths, VERSION, bridge.LEGACY_MODE),
        )
        bridge.atomic_write_json(paths.status, self.valid_status())
        self.write_owned(paths.pid, '9999\n')
        lock = DummyLock()
        with (
            patch.object(bridge, 'acquire_global_lock', return_value=lock),
            patch.object(bridge, 'process_is_alive', return_value=False),
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(
                bridge.cleanup_operation(OPERATION_ID, VERSION, bridge.LEGACY_MODE),
                0,
            )
        self.assertTrue(all(not target.exists() for target in paths.cleanup_targets()))
        self.assertTrue(other.exists())
        self.assertTrue(lock.closed)

    def test_cleanup_rejects_symlinks_without_deleting_their_target(self) -> None:
        paths = bridge.operation_paths(OPERATION_ID)
        bridge.atomic_write_json(
            paths.launch_state,
            bridge.launch_payload(paths, VERSION, bridge.LEGACY_MODE),
        )
        victim = self.root / 'victim'
        self.write_owned(victim, 'keep')
        try:
            paths.log.symlink_to(victim)
        except OSError as error:
            self.skipTest(f'symlinks are unavailable: {error}')
        lock = DummyLock()
        with (
            patch.object(bridge, 'acquire_global_lock', return_value=lock),
            self.assertRaises(bridge.BridgeError),
        ):
            bridge.cleanup_operation(OPERATION_ID, VERSION, bridge.LEGACY_MODE)
        self.assertEqual(victim.read_text(encoding='utf-8'), 'keep')


if __name__ == '__main__':
    unittest.main()
