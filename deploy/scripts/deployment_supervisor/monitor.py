"""Deployment worker observation, exit classification, and cleanup."""

from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path
from typing import Optional

from . import security, state


def read_pid(path: Path) -> Optional[int]:
    if not path.exists():
        if path.is_symlink():
            raise state.SupervisorError(f'worker pid path is unsafe: {path}')
        return None
    try:
        text = security.secure_read_bytes(path, max_bytes=32).decode('ascii').strip()
    except UnicodeDecodeError as error:
        raise state.SupervisorError('worker pid is not ASCII') from error
    if not text.isdigit():
        raise state.SupervisorError('worker pid is invalid')
    pid = int(text)
    if pid <= 0:
        return pid
    return pid


def operation_is_active(paths: state.OperationPaths) -> bool:
    try:
        lock = security.acquire_operation_lock(paths, nonblocking=True)
    except state.LockBusy:
        return True
    lock.close()
    return False


def _emit_status(payload: dict[str, object]) -> None:
    print(json.dumps(payload, sort_keys=True, separators=(',', ':')))


def wait_for_worker(
    operation_id: str,
    version: str,
    expected_control_plane_sha256: str,
    *,
    timeout: float = 900.0,
    poll_interval: float = 1.0,
) -> int:
    paths = state.operation_paths(operation_id)
    version = state.require_version(version)
    expected_control_plane_sha256 = state.require_control_plane_sha256(
        expected_control_plane_sha256
    )
    if (
        not math.isfinite(timeout)
        or not math.isfinite(poll_interval)
        or timeout < 0
        or poll_interval <= 0
    ):
        raise state.SupervisorError('wait timeout and poll interval must be positive')
    deadline = time.monotonic() + timeout

    while True:
        if paths.status.exists() or paths.status.is_symlink():
            try:
                state.validate_launch_payload(
                    security.read_json_file(paths.launch_state),
                    paths,
                    version,
                    expected_control_plane_sha256,
                )
                raw_payload = security.read_json_file(paths.status)
                payload = state.validate_worker_status(
                    raw_payload,
                    paths,
                    version,
                    expected_control_plane_sha256,
                )
            except state.SupervisorError as error:
                print(f'invalid deployment worker status: {error}', file=sys.stderr)
                try:
                    _emit_status(security.read_json_file(paths.status))
                except state.SupervisorError:
                    pass
                return state.WAIT_STATE_INVALID
            _emit_status(payload)
            if payload['exit_code'] == 0:
                return 0
            if payload['exit_code'] == state.WORKER_LOCKED:
                return state.WAIT_WORKER_LOCKED
            return state.WAIT_DEPLOY_FAILED

        if operation_is_active(paths):
            if time.monotonic() >= deadline:
                print('timed out waiting for the deployment worker', file=sys.stderr)
                return state.WAIT_TIMEOUT
            time.sleep(min(poll_interval, max(0.0, deadline - time.monotonic())))
            continue

        worker_state_exists = any(
            target.exists() or target.is_symlink()
            for target in (paths.status, paths.pid, paths.log)
        )
        if not paths.launch_state.exists() and not paths.launch_state.is_symlink():
            unstarted_artifacts_exist = any(
                target.exists() or target.is_symlink()
                for target in (
                    paths.supervisor,
                    paths.source_archive,
                    paths.image_archive,
                    paths.retired_files,
                )
            )
            if worker_state_exists:
                print('deployment worker state is missing its operation binding', file=sys.stderr)
                return state.WAIT_STATE_INVALID
            if unstarted_artifacts_exist:
                print('deployment failed before publishing its operation claim', file=sys.stderr)
                return state.WAIT_DEPLOY_FAILED
            print('deployment worker state does not exist', file=sys.stderr)
            return state.WAIT_STATE_MISSING
        try:
            launch_payload = security.read_json_file(paths.launch_state)
        except state.SupervisorError as error:
            if not worker_state_exists:
                print('deployment failed before completing its operation claim', file=sys.stderr)
                return state.WAIT_DEPLOY_FAILED
            print(f'invalid deployment operation state: {error}', file=sys.stderr)
            return state.WAIT_STATE_INVALID
        try:
            state.validate_launch_payload(
                launch_payload,
                paths,
                version,
                expected_control_plane_sha256,
            )
        except state.SupervisorError as error:
            print(f'invalid deployment operation state: {error}', file=sys.stderr)
            return state.WAIT_STATE_INVALID
        try:
            if paths.pid.exists() or paths.pid.is_symlink():
                read_pid(paths.pid)
        except state.SupervisorError as error:
            print(f'invalid deployment operation state: {error}', file=sys.stderr)
            return state.WAIT_STATE_INVALID
        print('deployment worker exited without writing status', file=sys.stderr)
        return state.WAIT_DEPLOY_FAILED


def cleanup_operation(
    operation_id: str,
    version: str,
    expected_control_plane_sha256: str,
) -> int:
    paths = state.operation_paths(operation_id)
    version = state.require_version(version)
    expected_control_plane_sha256 = state.require_control_plane_sha256(
        expected_control_plane_sha256
    )
    try:
        operation_lock = security.acquire_operation_lock(paths, nonblocking=True)
    except state.LockBusy as error:
        print(str(error), file=sys.stderr)
        return state.CLEANUP_WORKER_RUNNING
    try:
        try:
            lock = security.acquire_global_lock(nonblocking=True)
        except state.LockBusy as error:
            print(str(error), file=sys.stderr)
            return state.CLEANUP_WORKER_RUNNING
        try:
            worker_state_exists = any(
                target.exists() or target.is_symlink()
                for target in (paths.status, paths.pid, paths.log)
            )
            if paths.launch_state.exists() or paths.launch_state.is_symlink():
                security.lstat_regular(paths.launch_state, require_owner=True)
                try:
                    launch_payload = security.read_json_file(paths.launch_state)
                except state.SupervisorError:
                    if worker_state_exists:
                        raise
                else:
                    state.validate_launch_payload(
                        launch_payload,
                        paths,
                        version,
                        expected_control_plane_sha256,
                    )
                if paths.status.exists() or paths.status.is_symlink():
                    state.validate_worker_status(
                        security.read_json_file(paths.status),
                        paths,
                        version,
                        expected_control_plane_sha256,
                    )
            elif worker_state_exists:
                raise state.SupervisorError(
                    'unstarted operation has unsafe worker state without a launch claim'
                )
            if paths.pid.exists() or paths.pid.is_symlink():
                read_pid(paths.pid)

            # Validate every existing target before deleting any of them.  A single
            # symlink therefore stops cleanup without producing a partial result.
            for target in paths.cleanup_targets():
                if target.exists() or target.is_symlink():
                    security.lstat_regular(
                        target,
                        require_owner=target.parent == state.TMP_ROOT,
                    )
            for target in paths.cleanup_targets():
                security.safe_unlink(target)
        finally:
            lock.close()
    finally:
        operation_lock.close()
    print(json.dumps({'cleaned': True, 'operation_id': paths.operation_id}, sort_keys=True))
    return 0
