"""Detached stage-worker creation and execution."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import BinaryIO, Optional, TextIO

from . import security, state


def worker_command(
    paths: state.OperationPaths,
    version: str,
    expected_control_plane_sha256: str,
) -> list[str]:
    return [
        str(state.SUDO),
        '-n',
        str(state.DEPLOY_WRAPPER),
        'stage',
        '--archive',
        str(paths.source_archive),
        '--image-archive',
        str(paths.image_archive),
        '--version',
        state.require_version(version),
        '--expected-control-plane-sha256',
        state.require_control_plane_sha256(expected_control_plane_sha256),
    ]


def normalize_subprocess_returncode(returncode: int) -> int:
    if isinstance(returncode, bool) or not isinstance(returncode, int):
        raise state.SupervisorError('stage wrapper returned an invalid exit status')
    normalized = 128 + abs(returncode) if returncode < 0 else returncode
    if not 0 <= normalized <= 255:
        raise state.SupervisorError('stage wrapper exit status is outside 0..255')
    return normalized

def _append_log(log: TextIO, message: str) -> None:
    log.write(f'[deploy supervisor] {message}\n')
    log.flush()

def _create_worker_log(path: Path) -> TextIO:
    if path.parent != state.TMP_ROOT:
        raise state.SupervisorError('worker log must remain directly under /tmp')
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(path, flags, 0o600)
        return os.fdopen(descriptor, 'w', encoding='utf-8', buffering=1)
    except OSError as error:
        raise state.SupervisorError(f'cannot create worker log {path}: {error}') from error

def run_worker(
    operation_id: str,
    version: str,
    expected_control_plane_sha256: str,
    operation_lock_fd: int,
) -> int:
    paths = state.operation_paths(operation_id)
    version = state.require_version(version)
    expected_control_plane_sha256 = state.require_control_plane_sha256(
        expected_control_plane_sha256
    )
    exit_code = state.WORKER_INTERNAL_ERROR
    backup: Optional[state.BackupResult] = None
    log: Optional[TextIO] = None
    lock: Optional[BinaryIO] = None
    operation_lock: Optional[BinaryIO] = None
    try:
        operation_lock = security.adopt_operation_lock(operation_lock_fd, paths)
        log = _create_worker_log(paths.log)
        security.atomic_write_bytes(paths.pid, f'{os.getpid()}\n'.encode('ascii'))
        lock = security.acquire_global_lock(nonblocking=True)
        state.validate_launch_payload(
            security.read_json_file(paths.launch_state),
            paths,
            version,
            expected_control_plane_sha256,
        )
        security.validate_release_artifacts(paths)
        _append_log(log, 'starting the fixed stage deployment wrapper')
        completed = subprocess.run(
            worker_command(paths, version, expected_control_plane_sha256),
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
            close_fds=True,
        )
        exit_code = normalize_subprocess_returncode(completed.returncode)
        log.flush()
        try:
            os.fsync(log.fileno())
        except OSError:
            pass
        try:
            backup = state.parse_backup_log(security.secure_read_bytes(paths.log).decode('utf-8'), version)
        except (state.SupervisorError, UnicodeDecodeError) as error:
            _append_log(log, f'cannot establish the backup outcome: {error}')
            if exit_code == 0:
                exit_code = state.WORKER_INTERNAL_ERROR
        _append_log(log, f'stage wrapper exit code: {exit_code}')
    except state.LockBusy as error:
        exit_code = state.WORKER_LOCKED
        if log is not None:
            _append_log(log, str(error))
    except BaseException as error:
        exit_code = state.WORKER_INTERNAL_ERROR
        if log is not None:
            _append_log(log, f'worker failed safely: {type(error).__name__}: {error}')
    finally:
        if lock is not None:
            lock.close()
        if log is not None:
            log.close()
        status_persisted = True
        try:
            security.atomic_write_json(
                paths.status,
                state.worker_status(
                    paths,
                    version,
                    expected_control_plane_sha256,
                    exit_code,
                    backup,
                ),
            )
        except BaseException as error:
            # There is no safe fallback state.  Leaving status absent ensures
            # wait classifies the dead worker as an error rather than success.
            print(f'cannot persist deployment worker status: {error}', file=sys.stderr, flush=True)
            status_persisted = False
        if operation_lock is not None:
            operation_lock.close()
        if not status_persisted:
            return state.WORKER_INTERNAL_ERROR
    return 0

def supervisor_script_path(paths: state.OperationPaths, entrypoint: Path) -> Path:
    try:
        actual = entrypoint.resolve(strict=True)
    except OSError as error:
        raise state.SupervisorError(
            f'cannot resolve the running supervisor script: {error}'
        ) from error
    if actual != paths.supervisor or entrypoint.is_symlink():
        raise state.SupervisorError(
            f'supervisor must run from its fixed operation path: {paths.supervisor}'
        )
    security.lstat_regular(actual, require_owner=True)
    return actual

def start_worker(
    operation_id: str,
    version: str,
    expected_control_plane_sha256: str,
    *,
    entrypoint: Optional[Path] = None,
) -> int:
    paths = state.operation_paths(operation_id)
    version = state.require_version(version)
    expected_control_plane_sha256 = state.require_control_plane_sha256(
        expected_control_plane_sha256
    )
    operation_lock = security.acquire_operation_lock(paths, nonblocking=True)
    try:
        script = supervisor_script_path(paths, entrypoint or Path(sys.argv[0]))
        security.validate_release_artifacts(paths)
        if (
            paths.status.exists()
            or paths.status.is_symlink()
            or paths.log.exists()
            or paths.log.is_symlink()
            or paths.pid.exists()
            or paths.pid.is_symlink()
        ):
            raise state.SupervisorError('this supervisor operation has already been started')
        security.create_exclusive_json(
            paths.launch_state,
            state.launch_payload(paths, version, expected_control_plane_sha256),
        )
        command = [
            sys.executable,
            '-I',
            '-B',
            '-X',
            'utf8',
            str(script),
            '_worker',
            '--operation-lock-fd',
            str(operation_lock.fileno()),
            '--operation-id',
            paths.operation_id,
            '--version',
            version,
            '--expected-control-plane-sha256',
            expected_control_plane_sha256,
        ]
        try:
            process = subprocess.Popen(
                command,
                cwd=state.TMP_ROOT,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                pass_fds=(operation_lock.fileno(),),
                start_new_session=True,
            )
        except BaseException:
            try:
                security.atomic_write_json(
                    paths.status,
                    state.worker_status(
                        paths,
                        version,
                        expected_control_plane_sha256,
                        state.WORKER_INTERNAL_ERROR,
                        None,
                    ),
                )
            except BaseException:
                pass
            raise
    finally:
        operation_lock.close()
    print(
        json.dumps(
            {
                'operation_id': paths.operation_id,
                'pid': process.pid,
                'version': version,
                'expected_control_plane_sha256': expected_control_plane_sha256,
            },
            sort_keys=True,
        )
    )
    return 0
