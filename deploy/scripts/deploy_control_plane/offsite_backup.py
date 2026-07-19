"""Encrypted offsite backup upload and remote restore-drill boundary."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .common import (
    APP_DIR,
    PRODUCTION_BACKUPS,
    atomic_write_bytes,
    path_is_linklike,
)
from .database import exercise_restored_database, verify_sqlite_database


RCLONE_REMOTE_RE = re.compile(
    r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}:[A-Za-z0-9][A-Za-z0-9_./-]{0,511}$'
)
AGE_RECIPIENT_RE = re.compile(r'^age1[023456789acdefghjklmnpqrstuvwxyz]{20,}$')
OFFSITE_STATE_NAME = '.offsite-state.json'


@dataclass(frozen=True)
class OffsiteBackupConfig:
    remote: str
    recipient: str
    identity: Path


def config_from_environment(environment: dict[str, str]) -> OffsiteBackupConfig:
    try:
        return OffsiteBackupConfig(
            remote=environment['P2P_OFFSITE_BACKUP_REMOTE'],
            recipient=environment['P2P_OFFSITE_BACKUP_AGE_RECIPIENT'],
            identity=Path(environment['P2P_OFFSITE_BACKUP_AGE_IDENTITY']),
        )
    except KeyError as error:
        raise SystemExit(
            f'production offsite backup configuration is missing: {error.args[0]}'
        ) from error


def validate_offsite_backup_config(config: OffsiteBackupConfig) -> None:
    if not RCLONE_REMOTE_RE.fullmatch(config.remote):
        raise SystemExit('offsite backup rclone remote is invalid')
    _, remote_path = config.remote.split(':', 1)
    if '//' in remote_path or '..' in Path(remote_path).parts:
        raise SystemExit('offsite backup rclone remote is unsafe')
    if not AGE_RECIPIENT_RE.fullmatch(config.recipient):
        raise SystemExit('offsite backup age recipient is invalid')
    if not config.identity.is_absolute() or path_is_linklike(config.identity):
        raise SystemExit('offsite backup age identity path is unsafe')
    try:
        metadata = config.identity.stat()
    except OSError as error:
        raise SystemExit(f'offsite backup age identity is unavailable: {error}') from error
    if not stat.S_ISREG(metadata.st_mode):
        raise SystemExit('offsite backup age identity is not a regular file')
    if os.name != 'nt' and (metadata.st_uid != 0 or stat.S_IMODE(metadata.st_mode) != 0o600):
        raise SystemExit('offsite backup age identity must be root-owned with mode 0600')


def validated_config_from_environment(
    environment: dict[str, str],
) -> OffsiteBackupConfig:
    config = config_from_environment(environment)
    validate_offsite_backup_config(config)
    return config


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open('rb') as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    except OSError as error:
        raise SystemExit(f'cannot hash offsite backup artifact: {error}') from error
    return digest.hexdigest()


def run_offsite_command(command: list[str]) -> subprocess.CompletedProcess[str]:
    print('$', ' '.join(command), flush=True)
    result = subprocess.run(
        command,
        cwd=APP_DIR,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f'exit {result.returncode}'
        raise SystemExit(f'offsite backup command failed ({command[0]}): {detail}')
    return result


def load_offsite_backup_state() -> Optional[dict[str, object]]:
    path = PRODUCTION_BACKUPS / OFFSITE_STATE_NAME
    if not path.exists():
        return None
    if path_is_linklike(path) or not path.is_file() or path.stat().st_size > 64 * 1024:
        raise SystemExit('offsite backup state is unsafe')
    try:
        state = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f'offsite backup state is invalid: {error}') from error
    expected = {
        'schema',
        'backup',
        'source_sha256',
        'remote_prefix',
        'remote_object',
        'ciphertext_sha256',
        'ciphertext_bytes',
    }
    if not isinstance(state, dict) or set(state) != expected or state.get('schema') != 1:
        raise SystemExit('offsite backup state schema is invalid')
    string_fields = (
        'backup',
        'source_sha256',
        'remote_prefix',
        'remote_object',
        'ciphertext_sha256',
    )
    if not all(isinstance(state.get(key), str) and state[key] for key in string_fields):
        raise SystemExit('offsite backup state fields are invalid')
    if not isinstance(state.get('ciphertext_bytes'), int):
        raise SystemExit('offsite backup state fields are invalid')
    if not re.fullmatch(r'[0-9a-f]{64}', str(state['source_sha256'])) or not re.fullmatch(
        r'[0-9a-f]{64}', str(state['ciphertext_sha256'])
    ):
        raise SystemExit('offsite backup state hashes are invalid')
    if int(state['ciphertext_bytes']) <= 0:
        raise SystemExit('offsite backup state size is invalid')
    return state


def write_offsite_backup_state(state: dict[str, object]) -> None:
    payload = (json.dumps(state, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
    atomic_write_bytes(PRODUCTION_BACKUPS / OFFSITE_STATE_NAME, payload, 0o600)


def sync_and_drill_offsite_backup(
    backup: Path,
    config: OffsiteBackupConfig,
) -> dict[str, object]:
    """Encrypt, upload, download, decrypt, and restore-drill one verified backup."""

    validate_offsite_backup_config(config)
    try:
        backup_root = PRODUCTION_BACKUPS.resolve(strict=True)
        resolved_backup = backup.resolve(strict=True)
    except OSError as error:
        raise SystemExit(f'offsite backup input is unavailable: {error}') from error
    if (
        resolved_backup.parent != backup_root
        or path_is_linklike(backup)
        or not resolved_backup.is_file()
    ):
        raise SystemExit('offsite backup input is unsafe')
    verify_sqlite_database(resolved_backup)
    source_sha256 = sha256_file(resolved_backup)
    state = load_offsite_backup_state()
    reuse = state is not None and all(
        (
            state['backup'] == backup.name,
            state['source_sha256'] == source_sha256,
            state['remote_prefix'] == config.remote,
            str(state['remote_object']).startswith(f'{config.remote.rstrip("/")}/'),
        )
    )

    with tempfile.TemporaryDirectory(prefix='.offsite-drill-', dir=backup_root) as directory:
        work = Path(directory)
        uploaded = False
        if reuse:
            assert state is not None
            remote_object = str(state['remote_object'])
            ciphertext_sha256 = str(state['ciphertext_sha256'])
            ciphertext_bytes = int(state['ciphertext_bytes'])
        else:
            encrypted = work / f'{backup.name}.age'
            run_offsite_command(
                ['age', '-r', config.recipient, '-o', str(encrypted), str(resolved_backup)]
            )
            if path_is_linklike(encrypted) or not encrypted.is_file():
                raise SystemExit('age did not create a safe encrypted backup')
            os.chmod(encrypted, 0o600)
            ciphertext_sha256 = sha256_file(encrypted)
            ciphertext_bytes = encrypted.stat().st_size
            remote_object = (
                f'{config.remote.rstrip("/")}/{backup.name}-'
                f'{ciphertext_sha256[:16]}.age'
            )
            run_offsite_command(
                ['rclone', 'copyto', '--immutable', str(encrypted), remote_object]
            )
            uploaded = True

        downloaded = work / 'downloaded-backup.age'
        run_offsite_command(['rclone', 'copyto', remote_object, str(downloaded)])
        if path_is_linklike(downloaded) or not downloaded.is_file():
            raise SystemExit('offsite backup download is missing or unsafe')
        if downloaded.stat().st_size != ciphertext_bytes:
            raise SystemExit('offsite backup download size does not match')
        if sha256_file(downloaded) != ciphertext_sha256:
            raise SystemExit('offsite backup download hash does not match')

        restored = work / 'restored.sqlite3'
        run_offsite_command(
            [
                'age',
                '-d',
                '-i',
                str(config.identity),
                '-o',
                str(restored),
                str(downloaded),
            ]
        )
        restored_bytes = exercise_restored_database(restored)
        next_state: dict[str, object] = {
            'schema': 1,
            'backup': backup.name,
            'source_sha256': source_sha256,
            'remote_prefix': config.remote,
            'remote_object': remote_object,
            'ciphertext_sha256': ciphertext_sha256,
            'ciphertext_bytes': ciphertext_bytes,
        }
        write_offsite_backup_state(next_state)

    return {
        'remote_object': remote_object,
        'ciphertext_sha256': ciphertext_sha256,
        'ciphertext_bytes': ciphertext_bytes,
        'restore_drill_bytes': restored_bytes,
        'uploaded': uploaded,
    }
