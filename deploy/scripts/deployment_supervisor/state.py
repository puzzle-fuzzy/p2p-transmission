"""Deployment supervisor state schema and pure validation rules."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


SCHEMA = 3
TMP_ROOT = Path('/tmp')
DEPLOY_WRAPPER = Path('/usr/local/sbin/p2p-transmission-deploy')
SUDO = Path('/usr/bin/sudo')
GLOBAL_LOCK = TMP_ROOT / 'p2p-transmission-deploy.lock'

OPERATION_ID_RE = re.compile(r'^[0-9a-f]{40}$')
VERSION_RE = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')
SHA256_RE = re.compile(r'^[0-9a-f]{64}$')
BACKUP_READY_PREFIX = 'production database backup ready: '
BACKUP_NOT_REQUIRED_LINE = 'production database is not present; backup is not required'
MAX_JSON_BYTES = 64 * 1024

# Public wait classifications.  These deliberately do not overlap ordinary
# argparse failures and do not reuse the wrapper's own exit status.
WAIT_STATE_MISSING = 20
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
    supervisor: Path
    launch_state: Path
    status: Path
    log: Path
    pid: Path
    operation_lock: Path
    source_archive: Path
    image_archive: Path

    def cleanup_targets(self) -> tuple[Path, ...]:
        return (
            self.launch_state,
            self.status,
            self.log,
            self.pid,
            self.source_archive,
            self.image_archive,
            self.supervisor,
        )


@dataclass(frozen=True)
class BackupResult:
    database_backup: Optional[str]
    backup_not_required: bool


class SupervisorError(RuntimeError):
    """A supervisor safety or state validation failure."""


class LockBusy(SupervisorError):
    """A deployment lock is already held."""


def require_operation_id(value: str) -> str:
    if not OPERATION_ID_RE.fullmatch(value):
        raise SupervisorError('operation-id must be a 40-character lowercase commit SHA')
    return value


def require_version(value: str) -> str:
    if not VERSION_RE.fullmatch(value):
        raise SupervisorError('release version contains unsupported characters')
    return value


def require_control_plane_sha256(value: str) -> str:
    if not SHA256_RE.fullmatch(value):
        raise SupervisorError(
            'expected control-plane SHA-256 must be 64 lowercase hex characters'
        )
    return value


def operation_paths(operation_id: str) -> OperationPaths:
    operation_id = require_operation_id(operation_id)
    prefix = f'p2p-transmission-deploy-{operation_id}'
    return OperationPaths(
        operation_id=operation_id,
        supervisor=TMP_ROOT / f'{prefix}-supervisor.py',
        launch_state=TMP_ROOT / f'{prefix}-operation.json',
        status=TMP_ROOT / f'{prefix}-status.json',
        log=TMP_ROOT / f'{prefix}-worker.log',
        pid=TMP_ROOT / f'{prefix}-worker.pid',
        operation_lock=TMP_ROOT / f'{prefix}-worker.lock',
        source_archive=TMP_ROOT / f'p2p-transmission-{operation_id}.tar.gz',
        image_archive=TMP_ROOT / f'p2p-transmission-image-{operation_id}.tar.gz',
    )

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
                raise SupervisorError('deployment helper reported an unsafe database backup path')
            records.append(BackupResult(raw_path, False))
    if len(records) != 1:
        raise SupervisorError(
            'successful deployment must report exactly one database backup outcome'
        )
    return records[0]

def launch_payload(
    paths: OperationPaths,
    version: str,
    expected_control_plane_sha256: str,
) -> dict[str, object]:
    return {
        'schema': SCHEMA,
        'operation_id': paths.operation_id,
        'version': require_version(version),
        'expected_control_plane_sha256': require_control_plane_sha256(
            expected_control_plane_sha256
        ),
        'started': True,
    }

def validate_launch_payload(
    payload: dict[str, object],
    paths: OperationPaths,
    version: str,
    expected_control_plane_sha256: str,
) -> dict[str, object]:
    version = require_version(version)
    expected_control_plane_sha256 = require_control_plane_sha256(
        expected_control_plane_sha256
    )
    if payload != launch_payload(paths, version, expected_control_plane_sha256):
        raise SupervisorError(
            'operation state does not match the requested version and control plane'
        )
    return payload

def worker_status(
    paths: OperationPaths,
    version: str,
    expected_control_plane_sha256: str,
    exit_code: int,
    backup: Optional[BackupResult],
) -> dict[str, object]:
    payload: dict[str, object] = {
        'schema': SCHEMA,
        'operation_id': paths.operation_id,
        'version': require_version(version),
        'expected_control_plane_sha256': require_control_plane_sha256(
            expected_control_plane_sha256
        ),
        'exit_code': exit_code,
        'database_backup': backup.database_backup if backup is not None else None,
        'database_backup_not_required': (
            backup.backup_not_required if backup is not None else False
        ),
        'finished': True,
    }
    return payload

def validate_worker_status(
    payload: dict[str, object],
    paths: OperationPaths,
    version: str,
    expected_control_plane_sha256: str,
) -> dict[str, object]:
    expected_control_plane_sha256 = require_control_plane_sha256(
        expected_control_plane_sha256
    )
    if (
        payload.get('schema') != SCHEMA
        or payload.get('operation_id') != paths.operation_id
        or payload.get('version') != version
        or payload.get('expected_control_plane_sha256')
        != expected_control_plane_sha256
        or payload.get('finished') is not True
        or isinstance(payload.get('exit_code'), bool)
        or not isinstance(payload.get('exit_code'), int)
    ):
        raise SupervisorError('worker status metadata is invalid')
    exit_code = payload['exit_code']
    assert isinstance(exit_code, int)
    if not 0 <= exit_code <= 255:
        raise SupervisorError('worker status exit code is invalid')

    database_backup = payload.get('database_backup')
    backup_not_required = payload.get('database_backup_not_required')
    if isinstance(database_backup, str) and backup_not_required is False:
        parsed = parse_backup_log(
            f'{BACKUP_READY_PREFIX}{database_backup}\n',
            version,
        )
        if parsed.database_backup != database_backup:
            raise SupervisorError('worker database backup path is invalid')
    elif database_backup is None and backup_not_required is True:
        pass
    elif (
        exit_code != 0
        and database_backup is None
        and backup_not_required is False
    ):
        # A lock-rejected worker never invoked the helper. Other helper failures
        # are covered by their durable pending-release state once this
        # detached worker is known to have stopped.
        pass
    else:
        raise SupervisorError('worker status does not establish a database backup outcome')
    return payload
