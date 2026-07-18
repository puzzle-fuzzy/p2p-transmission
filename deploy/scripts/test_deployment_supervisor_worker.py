from __future__ import annotations

import io
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import Mock, patch

import build_deployment_supervisor as builder
from deployment_supervisor import monitor, security, state, worker
from deployment_supervisor_test_support import (
    CONTROL_PLANE_SHA256,
    OPERATION_ID,
    VERSION,
    DummyLock,
    SupervisorTestCase,
)


class DeploymentSupervisorWorkerTests(SupervisorTestCase):
    def test_worker_command_is_the_fixed_stage_invocation(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        self.assertEqual(
            worker.worker_command(paths, VERSION, CONTROL_PLANE_SHA256),
            [
                str(state.SUDO),
                '-n',
                str(state.DEPLOY_WRAPPER),
                'stage',
                '--archive',
                str(paths.source_archive),
                '--image-archive',
                str(paths.image_archive),
                '--retired-files',
                str(paths.retired_files),
                '--version',
                VERSION,
                '--expected-control-plane-sha256',
                CONTROL_PLANE_SHA256,
            ],
        )

    def test_cross_operation_lock_contention_has_a_nonrollback_wait_code(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        security.atomic_write_json(
            paths.launch_state,
            state.launch_payload(paths, VERSION, CONTROL_PLANE_SHA256),
        )
        with (
            patch.object(
                security,
                'adopt_operation_lock',
                return_value=DummyLock(),
            ),
            patch.object(
                security,
                'acquire_global_lock',
                side_effect=state.LockBusy('another operation owns the lock'),
            ),
            patch.object(worker.subprocess, 'run') as deploy,
        ):
            self.assertEqual(
                worker.run_worker(OPERATION_ID, VERSION, CONTROL_PLANE_SHA256, 91),
                0,
            )
        deploy.assert_not_called()

        status = security.read_json_file(paths.status)
        self.assertEqual(status['exit_code'], state.WORKER_LOCKED)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            wait_code = monitor.wait_for_worker(
                OPERATION_ID,
                VERSION,
                CONTROL_PLANE_SHA256,
                timeout=0,
            )
        self.assertEqual(wait_code, state.WAIT_WORKER_LOCKED)
        self.assertNotIn(wait_code, (0, state.WAIT_DEPLOY_FAILED))

    def test_worker_uses_only_fixed_sudo_wrapper_command_and_writes_status(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        for artifact in (paths.source_archive, paths.image_archive, paths.retired_files):
            self.write_owned(artifact)
        backup_path = (
            '/opt/p2p-transmission/deploy/production/backups/'
            f'control-20260717T123456123456Z-{VERSION}.sqlite3'
        )

        def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
            log = kwargs['stdout']
            assert hasattr(log, 'write')
            log.write(f'{state.BACKUP_READY_PREFIX}{backup_path}\n')
            return subprocess.CompletedProcess(command, 0)

        lock = DummyLock()
        operation_lock = DummyLock()
        security.atomic_write_json(
            paths.launch_state,
            state.launch_payload(paths, VERSION, CONTROL_PLANE_SHA256),
        )
        with (
            patch.object(
                security,
                'adopt_operation_lock',
                return_value=operation_lock,
            ),
            patch.object(security, 'acquire_global_lock', return_value=lock),
            patch.object(worker.subprocess, 'run', side_effect=fake_run) as run,
        ):
            self.assertEqual(
                worker.run_worker(OPERATION_ID, VERSION, CONTROL_PLANE_SHA256, 91),
                0,
            )

        expected = [
            str(state.SUDO),
            '-n',
            str(state.DEPLOY_WRAPPER),
            'stage',
            '--archive',
            str(paths.source_archive),
            '--image-archive',
            str(paths.image_archive),
            '--retired-files',
            str(paths.retired_files),
            '--version',
            VERSION,
            '--expected-control-plane-sha256',
            CONTROL_PLANE_SHA256,
        ]
        self.assertEqual(run.call_args.args[0], expected)
        self.assertTrue(run.call_args.kwargs['close_fds'])
        status = security.read_json_file(paths.status)
        self.assertEqual(status['exit_code'], 0)
        self.assertNotIn('mode', status)
        self.assertEqual(status['database_backup'], backup_path)
        self.assertFalse(status['database_backup_not_required'])
        self.assertTrue(status['finished'])
        self.assertTrue(lock.closed)
        self.assertTrue(operation_lock.closed)

    def test_start_detaches_same_supervisor_script(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        builder.build_bundle(paths.supervisor)
        paths.supervisor.chmod(0o600)
        process = Mock(pid=4312)
        operation_lock = DummyLock(93)
        with (
            patch.object(
                security,
                'acquire_operation_lock',
                return_value=operation_lock,
            ),
            patch.object(security, 'validate_release_artifacts'),
            patch.object(worker.subprocess, 'Popen', return_value=process) as popen,
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(
                worker.start_worker(
                    OPERATION_ID,
                    VERSION,
                    CONTROL_PLANE_SHA256,
                    entrypoint=paths.supervisor,
                ),
                0,
            )
        command = popen.call_args.args[0]
        self.assertEqual(command[:6], [
            worker.sys.executable,
            '-I',
            '-B',
            '-X',
            'utf8',
            str(paths.supervisor),
        ])
        self.assertEqual(command[6], '_worker')
        self.assertEqual(
            command[7:9],
            ['--operation-lock-fd', str(operation_lock.fileno())],
        )
        self.assertEqual(
            command[-4:],
            [
                '--version',
                VERSION,
                '--expected-control-plane-sha256',
                CONTROL_PLANE_SHA256,
            ],
        )
        self.assertNotIn('--mode', command)
        self.assertTrue(popen.call_args.kwargs['start_new_session'])
        self.assertEqual(
            popen.call_args.kwargs['pass_fds'],
            (operation_lock.fileno(),),
        )
        self.assertFalse(paths.pid.exists())
        self.assertTrue(operation_lock.closed)
        self.assertEqual(
            security.read_json_file(paths.launch_state),
            state.launch_payload(paths, VERSION, CONTROL_PLANE_SHA256),
        )

    def test_signal_returncode_becomes_a_valid_failed_terminal_status(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        for artifact in (paths.source_archive, paths.image_archive, paths.retired_files):
            self.write_owned(artifact)
        security.atomic_write_json(
            paths.launch_state,
            state.launch_payload(paths, VERSION, CONTROL_PLANE_SHA256),
        )
        with (
            patch.object(
                security,
                'adopt_operation_lock',
                return_value=DummyLock(),
            ),
            patch.object(security, 'acquire_global_lock', return_value=DummyLock()),
            patch.object(
                worker.subprocess,
                'run',
                return_value=subprocess.CompletedProcess([], -15),
            ),
        ):
            self.assertEqual(
                worker.run_worker(OPERATION_ID, VERSION, CONTROL_PLANE_SHA256, 91),
                0,
            )

        status = security.read_json_file(paths.status)
        self.assertEqual(status['exit_code'], 143)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(
                monitor.wait_for_worker(
                    OPERATION_ID,
                    VERSION,
                    CONTROL_PLANE_SHA256,
                    timeout=0,
                ),
                state.WAIT_DEPLOY_FAILED,
            )

    def test_returncode_normalization_enforces_a_valid_process_status(self) -> None:
        self.assertEqual(worker.normalize_subprocess_returncode(-1), 129)
        self.assertEqual(worker.normalize_subprocess_returncode(-127), 255)
        self.assertEqual(worker.normalize_subprocess_returncode(255), 255)
        for invalid in (-128, 256, True):
            with self.subTest(invalid=invalid), self.assertRaises(state.SupervisorError):
                worker.normalize_subprocess_returncode(invalid)

    def test_popen_failure_preserves_claim_and_terminal_failure(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        builder.build_bundle(paths.supervisor)
        paths.supervisor.chmod(0o600)
        operation_lock = DummyLock(93)
        with (
            patch.object(
                security,
                'acquire_operation_lock',
                return_value=operation_lock,
            ),
            patch.object(security, 'validate_release_artifacts'),
            patch.object(worker.subprocess, 'Popen', side_effect=OSError('injected')),
            self.assertRaises(OSError),
        ):
            worker.start_worker(
                OPERATION_ID,
                VERSION,
                CONTROL_PLANE_SHA256,
                entrypoint=paths.supervisor,
            )

        self.assertTrue(operation_lock.closed)
        self.assertTrue(paths.launch_state.exists())
        self.assertFalse(paths.pid.exists())
        self.assertEqual(
            security.read_json_file(paths.status)['exit_code'],
            state.WORKER_INTERNAL_ERROR,
        )
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(
                monitor.wait_for_worker(
                    OPERATION_ID,
                    VERSION,
                    CONTROL_PLANE_SHA256,
                    timeout=0,
                ),
                state.WAIT_DEPLOY_FAILED,
            )

    def test_concurrent_start_has_one_exclusive_claim_and_one_child(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        barrier = threading.Barrier(2)
        original_claim = security.create_exclusive_json
        locks = [DummyLock(101), DummyLock(102)]

        def contested_claim(*args: object, **kwargs: object) -> None:
            barrier.wait(timeout=5)
            original_claim(*args, **kwargs)

        def start() -> object:
            try:
                return worker.start_worker(
                    OPERATION_ID,
                    VERSION,
                    CONTROL_PLANE_SHA256,
                    entrypoint=paths.supervisor,
                )
            except state.SupervisorError:
                return 'claimed'

        with (
            patch.object(
                security,
                'acquire_operation_lock',
                side_effect=locks,
            ),
            patch.object(worker, 'supervisor_script_path', return_value=paths.supervisor),
            patch.object(security, 'validate_release_artifacts'),
            patch.object(security, 'create_exclusive_json', side_effect=contested_claim),
            patch.object(worker.subprocess, 'Popen', return_value=Mock(pid=4312)) as popen,
            redirect_stdout(io.StringIO()),
        ):
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(lambda _: start(), range(2)))

        self.assertCountEqual(results, [0, 'claimed'])
        popen.assert_called_once()
        self.assertTrue(all(lock.closed for lock in locks))

    def test_child_pid_write_failure_never_invokes_stage_and_is_recoverable(self) -> None:
        paths = state.operation_paths(OPERATION_ID)
        security.atomic_write_json(
            paths.launch_state,
            state.launch_payload(paths, VERSION, CONTROL_PLANE_SHA256),
        )
        original_write = security.atomic_write_bytes

        def fail_pid(path: object, payload: bytes) -> None:
            if path == paths.pid:
                raise state.SupervisorError('injected pid persistence failure')
            original_write(path, payload)

        operation_lock = DummyLock()
        with (
            patch.object(
                security,
                'adopt_operation_lock',
                return_value=operation_lock,
            ),
            patch.object(security, 'atomic_write_bytes', side_effect=fail_pid),
            patch.object(worker.subprocess, 'run') as stage,
        ):
            self.assertEqual(
                worker.run_worker(OPERATION_ID, VERSION, CONTROL_PLANE_SHA256, 91),
                0,
            )

        stage.assert_not_called()
        self.assertTrue(operation_lock.closed)
        self.assertFalse(paths.pid.exists())
        self.assertEqual(
            security.read_json_file(paths.status)['exit_code'],
            state.WORKER_INTERNAL_ERROR,
        )
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(
                monitor.wait_for_worker(
                    OPERATION_ID,
                    VERSION,
                    CONTROL_PLANE_SHA256,
                    timeout=0,
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
                    OPERATION_ID,
                    VERSION,
                    CONTROL_PLANE_SHA256,
                ),
                0,
            )


if __name__ == '__main__':
    import unittest

    unittest.main()
