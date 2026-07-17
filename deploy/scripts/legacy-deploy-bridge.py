#!/usr/bin/env python3
"""Safely supervise a deployment helper invocation across SSH disconnects.

The bridge runs as the unprivileged deploy account.  Its worker is detached so
an interrupted SSH connection cannot terminate a deployment in the middle of a
runtime switch.  The worker's only privileged command is the already-installed
and sudo-approved wrapper with a fixed argument set selected by an explicitly
bound helper mode.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Optional, TextIO

try:  # pragma: no cover - unavailable on Windows, where the unit tests run.
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]


SCHEMA = 1
TMP_ROOT = Path('/tmp')
APP_DIR = Path('/opt/p2p-transmission')
PRODUCTION_COMPOSE = APP_DIR / 'deploy/production/compose.yml'
PRODUCTION_NGINX = Path('/etc/nginx/conf.d/p2p.yxswy.com.conf')
LEGACY_HELPER = APP_DIR / 'deploy/scripts/deploy-release.py'
LEGACY_WRAPPER = Path('/usr/local/sbin/p2p-transmission-deploy')
READINESS_URL = 'http://127.0.0.1:3410/health/ready'
GLOBAL_LOCK = TMP_ROOT / 'p2p-transmission-legacy-deploy.lock'

LEGACY_MODE = 'legacy'
V2_MODE = 'v2'
HELPER_MODES = (LEGACY_MODE, V2_MODE)

OPERATION_ID_RE = re.compile(r'^[0-9a-f]{40}$')
VERSION_RE = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')
SHA256_RE = re.compile(r'^[0-9a-f]{64}$')
BACKUP_READY_PREFIX = 'production database backup ready: '
BACKUP_NOT_REQUIRED_LINE = 'production database is not present; backup is not required'
MAX_JSON_BYTES = 64 * 1024

# Public wait classifications.  These deliberately do not overlap ordinary
# argparse failures and do not reuse the legacy wrapper's own exit status.
WAIT_STATE_MISSING = 20
WAIT_PROCESS_DIED = 21
WAIT_TIMEOUT = 22
WAIT_DEPLOY_FAILED = 23
WAIT_STATE_INVALID = 24
WAIT_WORKER_LOCKED = 25
CLEANUP_WORKER_RUNNING = 30
WORKER_INTERNAL_ERROR = 70
WORKER_LOCKED = 75


@dataclass(frozen=True)
class OperationPaths:
    operation_id: str
    bridge: Path
    snapshot_state: Path
    launch_state: Path
    status: Path
    log: Path
    pid: Path
    compose_snapshot: Path
    nginx_snapshot: Path
    source_archive: Path
    image_archive: Path
    retired_files: Path

    def cleanup_targets(self) -> tuple[Path, ...]:
        return (
            self.snapshot_state,
            self.launch_state,
            self.status,
            self.log,
            self.pid,
            self.compose_snapshot,
            self.nginx_snapshot,
            self.source_archive,
            self.image_archive,
            self.retired_files,
            self.bridge,
        )


@dataclass(frozen=True)
class BackupResult:
    database_backup: Optional[str]
    backup_not_required: bool


class BridgeError(RuntimeError):
    """A bridge safety or state validation failure."""


class LockBusy(BridgeError):
    """The global deployment lock is already held."""


def require_operation_id(value: str) -> str:
    if not OPERATION_ID_RE.fullmatch(value):
        raise BridgeError('operation-id must be a 40-character lowercase commit SHA')
    return value


def require_version(value: str) -> str:
    if not VERSION_RE.fullmatch(value):
        raise BridgeError('release version contains unsupported characters')
    return value


def require_mode(value: str) -> str:
    if value not in HELPER_MODES:
        raise BridgeError(f'helper mode must be one of: {", ".join(HELPER_MODES)}')
    return value


def operation_paths(operation_id: str) -> OperationPaths:
    operation_id = require_operation_id(operation_id)
    prefix = f'p2p-transmission-legacy-{operation_id}'
    return OperationPaths(
        operation_id=operation_id,
        bridge=TMP_ROOT / f'{prefix}-bridge.py',
        snapshot_state=TMP_ROOT / f'{prefix}-snapshot.json',
        launch_state=TMP_ROOT / f'{prefix}-operation.json',
        status=TMP_ROOT / f'{prefix}-status.json',
        log=TMP_ROOT / f'{prefix}-worker.log',
        pid=TMP_ROOT / f'{prefix}-worker.pid',
        compose_snapshot=TMP_ROOT / f'{prefix}-compose.yml',
        nginx_snapshot=TMP_ROOT / f'{prefix}-nginx.conf',
        source_archive=TMP_ROOT / f'p2p-transmission-{operation_id}.tar.gz',
        image_archive=TMP_ROOT / f'p2p-transmission-image-{operation_id}.tar.gz',
        retired_files=TMP_ROOT / f'p2p-transmission-retired-{operation_id}.json',
    )


def _current_uid() -> Optional[int]:
    getuid = getattr(os, 'getuid', None)
    return getuid() if getuid is not None else None


def _lstat_regular(path: Path, *, require_owner: bool = False) -> os.stat_result:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise BridgeError(f'required file is unavailable: {path}: {error}') from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise BridgeError(f'file is not a safe regular file: {path}')
    uid = _current_uid()
    if require_owner and uid is not None and metadata.st_uid != uid:
        raise BridgeError(f'file is not owned by the deploy account: {path}')
    if require_owner and os.name != 'nt' and stat.S_IMODE(metadata.st_mode) & 0o077:
        raise BridgeError(f'file permissions must be 0600: {path}')
    return metadata


def _ensure_absent_or_owned_regular(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        raise BridgeError(f'cannot inspect bridge file {path}: {error}') from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise BridgeError(f'bridge file is unsafe: {path}')
    uid = _current_uid()
    if uid is not None and metadata.st_uid != uid:
        raise BridgeError(f'bridge file is not owned by the deploy account: {path}')


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    """Atomically replace an operation-owned file with mode 0600."""

    if path.parent != TMP_ROOT:
        raise BridgeError(f'bridge output must stay directly under {TMP_ROOT}: {path}')
    _ensure_absent_or_owned_regular(path)
    descriptor: Optional[int] = None
    temporary: Optional[Path] = None
    try:
        descriptor, name = tempfile.mkstemp(prefix=f'.{path.name}.write-', dir=TMP_ROOT)
        temporary = Path(name)
        with os.fdopen(descriptor, 'wb') as destination:
            descriptor = None
            destination.write(payload)
            destination.flush()
            os.fsync(destination.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        temporary = None
    except OSError as error:
        raise BridgeError(f'cannot atomically write {path}: {error}') from error
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def atomic_write_json(path: Path, payload: dict[str, object]) -> None:
    rendered = (json.dumps(payload, sort_keys=True, separators=(',', ':')) + '\n').encode()
    atomic_write_bytes(path, rendered)


def secure_read_bytes(path: Path, *, max_bytes: Optional[int] = None) -> bytes:
    metadata = _lstat_regular(path, require_owner=path.parent == TMP_ROOT)
    if max_bytes is not None and metadata.st_size > max_bytes:
        raise BridgeError(f'bridge file exceeds its size limit: {path}')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, 'rb') as source:
            opened = os.fstat(source.fileno())
            if not stat.S_ISREG(opened.st_mode):
                raise BridgeError(f'file changed while it was opened: {path}')
            return source.read(max_bytes + 1 if max_bytes is not None else -1)
    except OSError as error:
        raise BridgeError(f'cannot read bridge file {path}: {error}') from error


def read_json_file(path: Path) -> dict[str, object]:
    raw = secure_read_bytes(path, max_bytes=MAX_JSON_BYTES)
    if len(raw) > MAX_JSON_BYTES:
        raise BridgeError(f'bridge JSON exceeds its size limit: {path}')
    try:
        payload = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BridgeError(f'bridge JSON is invalid: {path}: {error}') from error
    if not isinstance(payload, dict):
        raise BridgeError(f'bridge JSON must contain an object: {path}')
    return payload


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    _lstat_regular(path, require_owner=path.parent == TMP_ROOT)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, 'rb') as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise BridgeError(f'file changed while it was opened: {path}')
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
    except OSError as error:
        raise BridgeError(f'cannot hash {path}: {error}') from error
    return digest.hexdigest()


def snapshot_file(source: Path, destination: Path) -> None:
    if destination.parent != TMP_ROOT:
        raise BridgeError('snapshot destination must be directly under /tmp')
    _ensure_absent_or_owned_regular(destination)
    _lstat_regular(source)
    source_flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    source_descriptor: Optional[int] = None
    target_descriptor: Optional[int] = None
    temporary: Optional[Path] = None
    try:
        source_descriptor = os.open(source, source_flags)
        if not stat.S_ISREG(os.fstat(source_descriptor).st_mode):
            raise BridgeError(f'snapshot source changed while it was opened: {source}')
        target_descriptor, name = tempfile.mkstemp(
            prefix=f'.{destination.name}.copy-', dir=TMP_ROOT
        )
        temporary = Path(name)
        with os.fdopen(source_descriptor, 'rb') as source_file:
            source_descriptor = None
            with os.fdopen(target_descriptor, 'wb') as target_file:
                target_descriptor = None
                shutil.copyfileobj(source_file, target_file)
                target_file.flush()
                os.fsync(target_file.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
        temporary = None
    except OSError as error:
        raise BridgeError(f'cannot snapshot {source}: {error}') from error
    finally:
        for descriptor in (source_descriptor, target_descriptor):
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def current_production_release() -> str:
    try:
        with urllib.request.urlopen(READINESS_URL, timeout=5) as response:
            payload = json.loads(response.read().decode('utf-8'))
            status_code = response.status
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
        raise BridgeError(f'cannot read local production readiness: {error}') from error
    release = payload.get('release') if isinstance(payload, dict) else None
    if (
        status_code != 200
        or not isinstance(payload, dict)
        or payload.get('status') != 'ready'
        or payload.get('service') != 'p2p-server'
        or not isinstance(release, str)
    ):
        raise BridgeError('local production readiness payload is invalid')
    return require_version(release)


def snapshot_payload(paths: OperationPaths) -> dict[str, object]:
    lock = acquire_global_lock(nonblocking=True)
    try:
        previous_release = current_production_release()
        for target in (paths.snapshot_state, paths.compose_snapshot, paths.nginx_snapshot):
            if target.exists() or target.is_symlink():
                raise BridgeError(f'operation snapshot already exists: {target}')

        snapshot_file(PRODUCTION_COMPOSE, paths.compose_snapshot)
        snapshot_file(PRODUCTION_NGINX, paths.nginx_snapshot)
        compose_sha256 = file_sha256(PRODUCTION_COMPOSE)
        nginx_sha256 = file_sha256(PRODUCTION_NGINX)
        if file_sha256(paths.compose_snapshot) != compose_sha256:
            raise BridgeError('production Compose changed while it was being snapshotted')
        if file_sha256(paths.nginx_snapshot) != nginx_sha256:
            raise BridgeError('production Nginx changed while it was being snapshotted')
        payload: dict[str, object] = {
            'schema': SCHEMA,
            'operation_id': paths.operation_id,
            'mode': LEGACY_MODE,
            'previous_release': previous_release,
            'compose_snapshot': str(paths.compose_snapshot),
            'compose_sha256': compose_sha256,
            'nginx_snapshot': str(paths.nginx_snapshot),
            'nginx_sha256': nginx_sha256,
            'helper_sha256': file_sha256(LEGACY_HELPER),
            'wrapper_sha256': file_sha256(LEGACY_WRAPPER),
        }
        atomic_write_json(paths.snapshot_state, payload)
    except BaseException:
        for target in (paths.compose_snapshot, paths.nginx_snapshot, paths.snapshot_state):
            try:
                safe_unlink(target)
            except BridgeError:
                pass
        raise
    finally:
        lock.close()
    return payload


def validate_snapshot(paths: OperationPaths) -> dict[str, object]:
    payload = read_json_file(paths.snapshot_state)
    required_strings = (
        'previous_release',
        'compose_snapshot',
        'compose_sha256',
        'nginx_snapshot',
        'nginx_sha256',
        'helper_sha256',
        'wrapper_sha256',
    )
    if (
        payload.get('schema') != SCHEMA
        or payload.get('operation_id') != paths.operation_id
        or payload.get('mode') != LEGACY_MODE
    ):
        raise BridgeError('snapshot state does not match this bridge operation')
    if not all(isinstance(payload.get(key), str) for key in required_strings):
        raise BridgeError('snapshot state is incomplete')
    previous_release = payload['previous_release']
    assert isinstance(previous_release, str)
    require_version(previous_release)

    expected_paths = {
        'compose_snapshot': paths.compose_snapshot,
        'nginx_snapshot': paths.nginx_snapshot,
    }
    for key, expected_path in expected_paths.items():
        if payload[key] != str(expected_path):
            raise BridgeError(f'snapshot state contains an unexpected {key} path')
    hash_paths = {
        'compose_sha256': paths.compose_snapshot,
        'nginx_sha256': paths.nginx_snapshot,
        'helper_sha256': LEGACY_HELPER,
        'wrapper_sha256': LEGACY_WRAPPER,
    }
    for key, path in hash_paths.items():
        expected_hash = payload[key]
        if not isinstance(expected_hash, str) or not SHA256_RE.fullmatch(expected_hash):
            raise BridgeError(f'snapshot state contains an invalid {key}')
        if file_sha256(path) != expected_hash:
            raise BridgeError(f'{path} changed after the legacy baseline snapshot')

    # Runtime Compose and Nginx must still be the exact files that were
    # snapshotted.  This catches an overlapping deployment before sudo runs.
    if file_sha256(PRODUCTION_COMPOSE) != payload['compose_sha256']:
        raise BridgeError('production Compose changed after the legacy baseline snapshot')
    if file_sha256(PRODUCTION_NGINX) != payload['nginx_sha256']:
        raise BridgeError('production Nginx changed after the legacy baseline snapshot')
    if current_production_release() != previous_release:
        raise BridgeError('production release changed after the legacy baseline snapshot')
    return payload


def validate_release_artifacts(paths: OperationPaths) -> None:
    for artifact in (paths.source_archive, paths.image_archive, paths.retired_files):
        _lstat_regular(artifact, require_owner=True)


def parse_backup_log(text: str, version: str) -> BackupResult:
    version = require_version(version)
    records: list[BackupResult] = []
    backup_pattern = re.compile(
        r'^/opt/p2p-transmission/deploy/production/backups/'
        r'control-[0-9]{8}T[0-9]{12}Z-'
        + re.escape(version)
        + r'\.sqlite3$'
    )
    for line in text.splitlines():
        if line == BACKUP_NOT_REQUIRED_LINE:
            records.append(BackupResult(None, True))
        elif line.startswith(BACKUP_READY_PREFIX):
            raw_path = line[len(BACKUP_READY_PREFIX) :]
            if not backup_pattern.fullmatch(raw_path):
                raise BridgeError('legacy helper reported an unsafe database backup path')
            records.append(BackupResult(raw_path, False))
    if len(records) != 1:
        raise BridgeError('legacy helper must report exactly one database backup outcome')
    return records[0]


def _open_lock_file() -> BinaryIO:
    if GLOBAL_LOCK.parent != TMP_ROOT:
        raise BridgeError('global bridge lock must remain directly under /tmp')
    _ensure_absent_or_owned_regular(GLOBAL_LOCK)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(GLOBAL_LOCK, flags, 0o600)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            os.close(descriptor)
            raise BridgeError('global bridge lock is not a regular file')
        os.fchmod(descriptor, 0o600)
        return os.fdopen(descriptor, 'a+b', buffering=0)
    except OSError as error:
        raise BridgeError(f'cannot open global bridge lock: {error}') from error


def acquire_global_lock(*, nonblocking: bool = True) -> BinaryIO:
    if fcntl is None:
        raise BridgeError('the deployment bridge requires POSIX flock support')
    lock = _open_lock_file()
    flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0)
    try:
        fcntl.flock(lock.fileno(), flags)
    except BlockingIOError as error:
        lock.close()
        raise LockBusy('another deployment worker is already running') from error
    except OSError as error:
        lock.close()
        raise BridgeError(f'cannot acquire the global bridge lock: {error}') from error
    return lock


def launch_payload(
    paths: OperationPaths, version: str, mode: str
) -> dict[str, object]:
    return {
        'schema': SCHEMA,
        'operation_id': paths.operation_id,
        'version': require_version(version),
        'mode': require_mode(mode),
        'started': True,
    }


def validate_launch_state(
    paths: OperationPaths, version: str, mode: str
) -> dict[str, object]:
    version = require_version(version)
    mode = require_mode(mode)
    payload = read_json_file(paths.launch_state)
    if payload != launch_payload(paths, version, mode):
        raise BridgeError('operation state does not match the requested helper mode and version')
    return payload


def validate_mode_prerequisites(paths: OperationPaths, mode: str) -> None:
    mode = require_mode(mode)
    validate_release_artifacts(paths)
    if mode == LEGACY_MODE:
        validate_snapshot(paths)
        return

    # A v2 operation must never consume legacy preimages.  Their presence means
    # the workflow and the bridge disagree about the installed helper mode.
    for target in (paths.snapshot_state, paths.compose_snapshot, paths.nginx_snapshot):
        if target.exists() or target.is_symlink():
            raise BridgeError(f'v2 operation contains unexpected legacy state: {target}')


def worker_command(paths: OperationPaths, version: str, mode: str) -> list[str]:
    mode = require_mode(mode)
    command = [
        'sudo',
        '-n',
        str(LEGACY_WRAPPER),
    ]
    if mode == V2_MODE:
        command.append('stage')
    command.extend([
        '--archive',
        str(paths.source_archive),
        '--image-archive',
        str(paths.image_archive),
        '--retired-files',
        str(paths.retired_files),
        '--version',
        require_version(version),
    ])
    return command


def _append_log(log: TextIO, message: str) -> None:
    log.write(f'[deploy bridge] {message}\n')
    log.flush()


def worker_status(
    paths: OperationPaths,
    version: str,
    mode: str,
    exit_code: int,
    backup: Optional[BackupResult],
) -> dict[str, object]:
    payload: dict[str, object] = {
        'schema': SCHEMA,
        'operation_id': paths.operation_id,
        'version': version,
        'mode': require_mode(mode),
        'exit_code': exit_code,
        'database_backup': backup.database_backup if backup is not None else None,
        'database_backup_not_required': (
            backup.backup_not_required if backup is not None else False
        ),
        'finished': True,
    }
    return payload


def _create_worker_log(path: Path) -> TextIO:
    if path.parent != TMP_ROOT:
        raise BridgeError('worker log must remain directly under /tmp')
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(path, flags, 0o600)
        return os.fdopen(descriptor, 'w', encoding='utf-8', buffering=1)
    except OSError as error:
        raise BridgeError(f'cannot create worker log {path}: {error}') from error


def run_worker(operation_id: str, version: str, mode: str) -> int:
    paths = operation_paths(operation_id)
    version = require_version(version)
    mode = require_mode(mode)
    exit_code = WORKER_INTERNAL_ERROR
    backup: Optional[BackupResult] = None
    log: Optional[TextIO] = None
    lock: Optional[BinaryIO] = None
    try:
        atomic_write_bytes(paths.pid, f'{os.getpid()}\n'.encode('ascii'))
        log = _create_worker_log(paths.log)
        lock = acquire_global_lock(nonblocking=True)
        validate_launch_state(paths, version, mode)
        validate_mode_prerequisites(paths, mode)
        _append_log(log, f'starting the fixed {mode} deployment wrapper')
        completed = subprocess.run(
            worker_command(paths, version, mode),
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=False,
            close_fds=True,
        )
        exit_code = completed.returncode
        log.flush()
        try:
            os.fsync(log.fileno())
        except OSError:
            pass
        try:
            backup = parse_backup_log(secure_read_bytes(paths.log).decode('utf-8'), version)
        except (BridgeError, UnicodeDecodeError) as error:
            _append_log(log, f'cannot establish the backup outcome: {error}')
            if exit_code == 0:
                exit_code = WORKER_INTERNAL_ERROR
        _append_log(log, f'{mode} wrapper exit code: {exit_code}')
    except LockBusy as error:
        exit_code = WORKER_LOCKED
        if log is not None:
            _append_log(log, str(error))
    except BaseException as error:
        exit_code = WORKER_INTERNAL_ERROR
        if log is not None:
            _append_log(log, f'worker failed safely: {type(error).__name__}: {error}')
    finally:
        if lock is not None:
            lock.close()
        if log is not None:
            log.close()
        try:
            atomic_write_json(
                paths.status,
                worker_status(paths, version, mode, exit_code, backup),
            )
        except BaseException as error:
            # There is no safe fallback state.  Leaving status absent ensures
            # wait classifies the dead worker as an error rather than success.
            print(f'cannot persist deployment worker status: {error}', file=sys.stderr, flush=True)
            return WORKER_INTERNAL_ERROR
    return 0


def bridge_script_path(paths: OperationPaths) -> Path:
    try:
        actual = Path(__file__).resolve(strict=True)
    except OSError as error:
        raise BridgeError(f'cannot resolve the running bridge script: {error}') from error
    if actual != paths.bridge or Path(__file__).is_symlink():
        raise BridgeError(f'bridge must run from its fixed operation path: {paths.bridge}')
    _lstat_regular(actual, require_owner=True)
    return actual


def start_worker(operation_id: str, version: str, mode: str) -> int:
    paths = operation_paths(operation_id)
    version = require_version(version)
    mode = require_mode(mode)
    script = bridge_script_path(paths)
    validate_mode_prerequisites(paths, mode)
    if paths.launch_state.exists() or paths.launch_state.is_symlink():
        raise BridgeError('this bridge operation already has bound operation state')
    if (
        paths.status.exists()
        or paths.status.is_symlink()
        or paths.log.exists()
        or paths.log.is_symlink()
    ):
        raise BridgeError('this bridge operation has already been started')
    if paths.pid.exists() or paths.pid.is_symlink():
        raise BridgeError('this bridge operation already has a worker pid')

    # Reserve the pid path before publishing launch metadata, closing the
    # cleanup/start race.  The immutable launch record then binds every later
    # worker, wait and cleanup operation to this exact helper mode and version.
    atomic_write_bytes(paths.pid, b'0\n')
    try:
        atomic_write_json(paths.launch_state, launch_payload(paths, version, mode))
    except BaseException:
        safe_unlink(paths.pid)
        raise
    command = [
        sys.executable,
        str(script),
        '_worker',
        '--operation-id',
        paths.operation_id,
        '--version',
        version,
        '--mode',
        mode,
    ]
    try:
        process = subprocess.Popen(
            command,
            cwd=TMP_ROOT,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
        atomic_write_bytes(paths.pid, f'{process.pid}\n'.encode('ascii'))
    except BaseException:
        safe_unlink(paths.pid)
        safe_unlink(paths.launch_state)
        raise
    print(
        json.dumps(
            {
                'mode': mode,
                'operation_id': paths.operation_id,
                'pid': process.pid,
                'version': version,
            },
            sort_keys=True,
        )
    )
    return 0


def read_pid(path: Path) -> Optional[int]:
    if not path.exists():
        if path.is_symlink():
            raise BridgeError(f'worker pid path is unsafe: {path}')
        return None
    try:
        text = secure_read_bytes(path, max_bytes=32).decode('ascii').strip()
    except UnicodeDecodeError as error:
        raise BridgeError('worker pid is not ASCII') from error
    if not text.isdigit():
        raise BridgeError('worker pid is invalid')
    pid = int(text)
    if pid <= 0:
        return pid
    return pid


def process_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def validate_worker_status(
    payload: dict[str, object], paths: OperationPaths, version: str, mode: str
) -> dict[str, object]:
    mode = require_mode(mode)
    if (
        payload.get('schema') != SCHEMA
        or payload.get('operation_id') != paths.operation_id
        or payload.get('version') != version
        or payload.get('mode') != mode
        or payload.get('finished') is not True
        or isinstance(payload.get('exit_code'), bool)
        or not isinstance(payload.get('exit_code'), int)
    ):
        raise BridgeError('worker status metadata is invalid')
    exit_code = payload['exit_code']
    assert isinstance(exit_code, int)
    if not 0 <= exit_code <= 255:
        raise BridgeError('worker status exit code is invalid')

    database_backup = payload.get('database_backup')
    backup_not_required = payload.get('database_backup_not_required')
    if isinstance(database_backup, str) and backup_not_required is False:
        parsed = parse_backup_log(
            f'{BACKUP_READY_PREFIX}{database_backup}\n',
            version,
        )
        if parsed.database_backup != database_backup:
            raise BridgeError('worker database backup path is invalid')
    elif database_backup is None and backup_not_required is True:
        pass
    elif (
        (mode == V2_MODE and exit_code != 0 or exit_code == WORKER_LOCKED)
        and database_backup is None
        and backup_not_required is False
    ):
        # A lock-rejected worker never invoked either helper.  Other v2 helper
        # failures are covered by their durable pending-release state once this
        # detached worker is known to have stopped.
        pass
    else:
        raise BridgeError('worker status does not establish a database backup outcome')
    return payload


def _emit_status(payload: dict[str, object]) -> None:
    print(json.dumps(payload, sort_keys=True, separators=(',', ':')))


def wait_for_worker(
    operation_id: str,
    version: str,
    mode: str,
    *,
    timeout: float = 900.0,
    poll_interval: float = 1.0,
) -> int:
    paths = operation_paths(operation_id)
    version = require_version(version)
    mode = require_mode(mode)
    if timeout < 0 or poll_interval <= 0:
        raise BridgeError('wait timeout and poll interval must be positive')
    deadline = time.monotonic() + timeout

    if not paths.launch_state.exists() and not paths.launch_state.is_symlink():
        if any(
            target.exists() or target.is_symlink()
            for target in (paths.status, paths.pid, paths.log)
        ):
            print('deployment worker state is missing its mode binding', file=sys.stderr)
            return WAIT_STATE_INVALID
        print('deployment worker state does not exist', file=sys.stderr)
        return WAIT_STATE_MISSING
    try:
        validate_launch_state(paths, version, mode)
    except BridgeError as error:
        print(f'invalid deployment operation state: {error}', file=sys.stderr)
        return WAIT_STATE_INVALID

    while True:
        if paths.status.exists() or paths.status.is_symlink():
            try:
                raw_payload = read_json_file(paths.status)
                payload = validate_worker_status(raw_payload, paths, version, mode)
            except BridgeError as error:
                print(f'invalid deployment worker status: {error}', file=sys.stderr)
                try:
                    _emit_status(read_json_file(paths.status))
                except BridgeError:
                    pass
                return WAIT_STATE_INVALID
            _emit_status(payload)
            if payload['exit_code'] == 0:
                return 0
            if payload['exit_code'] == WORKER_LOCKED:
                return WAIT_WORKER_LOCKED
            return WAIT_DEPLOY_FAILED

        try:
            pid = read_pid(paths.pid)
        except BridgeError as error:
            print(f'invalid deployment worker pid: {error}', file=sys.stderr)
            return WAIT_PROCESS_DIED
        if pid is None:
            print('deployment worker pid does not exist', file=sys.stderr)
            return WAIT_STATE_MISSING
        if pid > 0 and not process_is_alive(pid):
            print('deployment worker exited without writing status', file=sys.stderr)
            return WAIT_PROCESS_DIED
        if time.monotonic() >= deadline:
            print('timed out waiting for the deployment worker', file=sys.stderr)
            return WAIT_TIMEOUT
        time.sleep(min(poll_interval, max(0.0, deadline - time.monotonic())))


def safe_unlink(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        raise BridgeError(f'cannot inspect cleanup target {path}: {error}') from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise BridgeError(f'cleanup target is not a safe regular file: {path}')
    uid = _current_uid()
    if path.parent == TMP_ROOT and uid is not None and metadata.st_uid != uid:
        raise BridgeError(f'cleanup target is not owned by the deploy account: {path}')
    try:
        path.unlink()
    except OSError as error:
        raise BridgeError(f'cannot remove cleanup target {path}: {error}') from error


def cleanup_operation(operation_id: str, version: str, mode: str) -> int:
    paths = operation_paths(operation_id)
    version = require_version(version)
    mode = require_mode(mode)
    try:
        lock = acquire_global_lock(nonblocking=True)
    except LockBusy as error:
        print(str(error), file=sys.stderr)
        return CLEANUP_WORKER_RUNNING
    try:
        validate_launch_state(paths, version, mode)
        if paths.status.exists() or paths.status.is_symlink():
            validate_worker_status(read_json_file(paths.status), paths, version, mode)
        pid = read_pid(paths.pid)
        if pid is not None and (pid == 0 or process_is_alive(pid)):
            print(
                'refusing cleanup while the operation worker may still be running',
                file=sys.stderr,
            )
            return CLEANUP_WORKER_RUNNING

        # Validate every existing target before deleting any of them.  A single
        # symlink therefore stops cleanup without producing a partial result.
        for target in paths.cleanup_targets():
            if target.exists() or target.is_symlink():
                _lstat_regular(target, require_owner=target.parent == TMP_ROOT)
        for target in paths.cleanup_targets():
            safe_unlink(target)
    finally:
        lock.close()
    print(json.dumps({'cleaned': True, 'operation_id': paths.operation_id}, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest='action', required=True)

    snapshot_parser = subparsers.add_parser('snapshot')
    snapshot_parser.add_argument('--operation-id', required=True)
    snapshot_parser.add_argument('--mode', required=True, choices=(LEGACY_MODE,))

    start_parser = subparsers.add_parser('start')
    start_parser.add_argument('--operation-id', required=True)
    start_parser.add_argument('--version', required=True)
    start_parser.add_argument('--mode', required=True, choices=HELPER_MODES)

    wait_parser = subparsers.add_parser('wait')
    wait_parser.add_argument('--operation-id', required=True)
    wait_parser.add_argument('--version', required=True)
    wait_parser.add_argument('--mode', required=True, choices=HELPER_MODES)
    wait_parser.add_argument('--timeout', type=float, default=900.0)
    wait_parser.add_argument('--poll-interval', type=float, default=1.0)

    cleanup_parser = subparsers.add_parser('cleanup')
    cleanup_parser.add_argument('--operation-id', required=True)
    cleanup_parser.add_argument('--version', required=True)
    cleanup_parser.add_argument('--mode', required=True, choices=HELPER_MODES)

    return parser


def main(argv: Optional[list[str]] = None) -> int:
    raw_arguments = list(sys.argv[1:] if argv is None else argv)
    if raw_arguments[:1] == ['_worker']:
        worker_parser = argparse.ArgumentParser(add_help=False)
        worker_parser.add_argument('_worker')
        worker_parser.add_argument('--operation-id', required=True)
        worker_parser.add_argument('--version', required=True)
        worker_parser.add_argument('--mode', required=True, choices=HELPER_MODES)
        arguments = worker_parser.parse_args(raw_arguments)
    else:
        arguments = build_parser().parse_args(raw_arguments)
    try:
        if getattr(arguments, '_worker', None) == '_worker':
            return run_worker(arguments.operation_id, arguments.version, arguments.mode)
        action = getattr(arguments, 'action', None)
        if action == 'snapshot':
            require_mode(arguments.mode)
            payload = snapshot_payload(operation_paths(arguments.operation_id))
            _emit_status(payload)
            return 0
        if action == 'start':
            return start_worker(arguments.operation_id, arguments.version, arguments.mode)
        if action == 'wait':
            return wait_for_worker(
                arguments.operation_id,
                arguments.version,
                arguments.mode,
                timeout=arguments.timeout,
                poll_interval=arguments.poll_interval,
            )
        if action == 'cleanup':
            return cleanup_operation(
                arguments.operation_id,
                arguments.version,
                arguments.mode,
            )
        raise BridgeError(f'unsupported action: {action}')
    except BridgeError as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
