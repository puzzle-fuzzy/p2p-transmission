#!/usr/bin/env python3
"""Atomically deploy a GitHub-built image on the production host."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import secrets
import shutil
import sqlite3
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from contextlib import closing
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Optional


APP_DIR = Path('/opt/p2p-transmission')
SOURCE_ARCHIVE_RE = re.compile(r'^p2p-transmission-[0-9a-f]{40}\.tar\.gz$')
IMAGE_ARCHIVE_RE = re.compile(r'^p2p-transmission-image-[0-9a-f]{40}\.tar\.gz$')
RETIRED_FILES_RE = re.compile(r'^p2p-transmission-retired-[0-9a-f]{40}\.json$')
LEGACY_OPERATION_RE = re.compile(
    r'^p2p-transmission-legacy-([0-9a-f]{40})-status\.json$'
)
LEGACY_COMPOSE_RE = re.compile(
    r'^p2p-transmission-legacy-([0-9a-f]{40})-compose\.yml$'
)
LEGACY_NGINX_RE = re.compile(
    r'^p2p-transmission-legacy-([0-9a-f]{40})-nginx\.conf$'
)
VERSION_RE = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')
SHA256_RE = re.compile(r'^[0-9a-f]{64}$')
ENV_KEY_RE = re.compile(r'^[A-Z][A-Z0-9_]*$')

PRODUCTION_ENV = APP_DIR / 'deploy/production/.env'
PRODUCTION_COMPOSE = APP_DIR / 'deploy/production/compose.yml'
PRODUCTION_DATA = APP_DIR / 'deploy/production/data'
PRODUCTION_DATABASE = PRODUCTION_DATA / 'control.sqlite3'
PRODUCTION_BACKUPS = APP_DIR / 'deploy/production/backups'
PRODUCTION_ROLLBACK = APP_DIR / 'deploy/production/rollback'
PRODUCTION_PROJECT = 'p2p-transmission-production'
DATABASE_BACKUP_LIMIT = 10
SOURCE_MANIFEST = APP_DIR / 'deploy/production/source-files.json'
NGINX_SOURCE = APP_DIR / 'deploy/production/nginx/p2p.yxswy.com.conf'
NGINX_TARGET = Path('/etc/nginx/conf.d/p2p.yxswy.com.conf')
PENDING_RELEASE = PRODUCTION_ROLLBACK / 'pending.json'
PENDING_RELEASE_SCHEMA = 2
PENDING_RELEASE_MAX_BYTES = 64 * 1024
NGINX_SNAPSHOT_PREFIX = 'p2p-transmission-nginx-'
COMPOSE_SNAPSHOT_PREFIX = 'p2p-transmission-compose-'

def run(command: list[str], *, cwd: Path = APP_DIR) -> subprocess.CompletedProcess[str]:
    print('$', ' '.join(command), flush=True)
    result = subprocess.run(command, cwd=cwd, text=True)
    if result.returncode != 0:
        raise SystemExit(result.returncode)
    return result


def best_effort(command: list[str], *, cwd: Path = APP_DIR) -> bool:
    print('$', ' '.join(command), '(rollback)', flush=True)
    return subprocess.run(command, cwd=cwd, text=True).returncode == 0


def compose_production(*arguments: str, compose_file: Path = PRODUCTION_COMPOSE) -> list[str]:
    return [
        'docker',
        'compose',
        '--project-name',
        PRODUCTION_PROJECT,
        '--project-directory',
        str(PRODUCTION_COMPOSE.parent),
        '--env-file',
        str(PRODUCTION_ENV),
        '-f',
        str(compose_file),
        *arguments,
    ]


def image_exists(image: str) -> bool:
    return subprocess.run(
        ['docker', 'image', 'inspect', image],
        capture_output=True,
    ).returncode == 0


def image_id(image: str) -> Optional[str]:
    result = subprocess.run(
        ['docker', 'image', 'inspect', '--format', '{{.Id}}', image],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    identifier = result.stdout.strip()
    return identifier or None


def running_production_image_id() -> Optional[str]:
    container = subprocess.run(
        compose_production('ps', '--quiet', 'app'),
        capture_output=True,
        text=True,
    )
    container_id = container.stdout.strip() if container.returncode == 0 else ''
    if not container_id or '\n' in container_id:
        return None
    inspected = subprocess.run(
        ['docker', 'container', 'inspect', '--format', '{{.Image}}', container_id],
        capture_output=True,
        text=True,
    )
    if inspected.returncode != 0:
        return None
    identifier = inspected.stdout.strip()
    return identifier or None


def validate_tmp_file(path: Path, pattern: re.Pattern[str], label: str) -> Path:
    resolved = path.resolve()
    if resolved.parent != Path('/tmp') or not pattern.fullmatch(resolved.name):
        raise SystemExit(f'{label} must use the expected name under /tmp')
    if not resolved.is_file() or resolved.is_symlink():
        raise SystemExit(f'{label} does not exist or is not a regular file')
    return resolved


def normalize_source_path(raw_path: str) -> str:
    if not raw_path or '\\' in raw_path:
        raise SystemExit(f'invalid source path: {raw_path!r}')
    raw_parts = raw_path.split('/')
    if any(part in {'', '.', '..'} for part in raw_parts):
        raise SystemExit(f'invalid source path: {raw_path!r}')
    path = PurePosixPath(raw_path)
    if path.is_absolute():
        raise SystemExit(f'invalid source path: {raw_path!r}')
    return path.as_posix()


def path_is_linklike(path: Path) -> bool:
    is_junction = getattr(path, 'is_junction', None)
    return path.is_symlink() or (is_junction is not None and is_junction())


def safe_source_target(relative: str) -> Path:
    pure = PurePosixPath(normalize_source_path(relative))
    root = APP_DIR.resolve()
    cursor = APP_DIR
    for part in pure.parts[:-1]:
        cursor /= part
        if path_is_linklike(cursor):
            raise SystemExit(f'source path crosses a symbolic link: {relative}')
        if cursor.exists() and not cursor.is_dir():
            raise SystemExit(f'source path has a non-directory parent: {relative}')
    target = APP_DIR.joinpath(*pure.parts)
    resolved_parent = target.parent.resolve()
    if resolved_parent != root and root not in resolved_parent.parents:
        raise SystemExit(f'source path escapes application directory: {relative}')
    return target


def atomic_write_bytes(target: Path, payload: bytes, mode: int) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor: Optional[int] = None
    temporary: Optional[Path] = None
    try:
        descriptor, name = tempfile.mkstemp(prefix=f'.{target.name}.write-', dir=target.parent)
        temporary = Path(name)
        with os.fdopen(descriptor, 'wb') as destination:
            descriptor = None
            destination.write(payload)
            destination.flush()
            os.fsync(destination.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, target)
        fsync_directory(target.parent)
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def source_archive_files(archive: Path) -> set[str]:
    files: set[str] = set()
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar.getmembers():
            if member.issym() or member.islnk():
                raise SystemExit('source archive must not contain symbolic links')
            if not member.isfile() and not member.isdir():
                raise SystemExit(f'source archive contains an unsupported entry: {member.name}')
            normalized = normalize_source_path(member.name.rstrip('/'))
            safe_source_target(normalized)
            if member.isfile():
                files.add(normalized)
    return files


def validate_source_archive(archive: Path) -> Path:
    resolved = validate_tmp_file(archive, SOURCE_ARCHIVE_RE, 'source archive')
    source_archive_files(resolved)
    return resolved


def validate_image_archive(archive: Path) -> Path:
    return validate_tmp_file(archive, IMAGE_ARCHIVE_RE, 'image archive')


def read_source_file_list(path: Path) -> set[str]:
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f'cannot read source file list {path}: {error}') from error
    if not isinstance(payload, list) or not all(isinstance(item, str) for item in payload):
        raise SystemExit(f'source file list must be a JSON string array: {path}')
    return {normalize_source_path(item) for item in payload}


def validate_retired_files(path: Path) -> tuple[Path, set[str]]:
    resolved = validate_tmp_file(path, RETIRED_FILES_RE, 'retired source file list')
    return resolved, read_source_file_list(resolved)


def source_path_is_protected(path: str) -> bool:
    parts = PurePosixPath(path).parts
    if not parts:
        return True
    if parts[0] == '.git':
        return True
    protected_prefixes = (
        ('deploy', 'production', '.env'),
        ('deploy', 'production', 'data'),
        ('deploy', 'production', 'backups'),
        ('deploy', 'production', 'rollback'),
        ('deploy', 'production', 'source-files.json'),
        ('deploy', 'coturn', '.local'),
        ('deploy', 'coturn', 'turnserver.conf'),
        ('deploy', '.env'),
        ('deploy', 'data'),
    )
    if any(parts[: len(prefix)] == prefix for prefix in protected_prefixes):
        return True
    if parts[:2] == ('deploy', 'coturn') and path.endswith(('.pem', '.key')):
        return True
    return parts[0] == 'deploy' and (
        path.endswith('.sqlite') or '.sqlite-' in PurePosixPath(path).name
    )


def write_source_manifest(files: set[str]) -> None:
    payload = (json.dumps(sorted(files), ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    atomic_write_bytes(SOURCE_MANIFEST, payload, 0o600)


def remove_retired_source_files(current_files: set[str], bootstrap_files: set[str]) -> int:
    previous_files = (
        read_source_file_list(SOURCE_MANIFEST) if SOURCE_MANIFEST.is_file() else bootstrap_files
    )
    retired = previous_files - current_files
    parent_directories: set[Path] = set()
    removed = 0

    for relative in sorted(retired, key=lambda item: (item.count('/'), item), reverse=True):
        if source_path_is_protected(relative):
            print(f'preserving protected production path: {relative}', flush=True)
            continue
        pure = PurePosixPath(relative)
        target = safe_source_target(relative)
        if target.is_symlink() or target.is_file():
            target.unlink()
            removed += 1
        elif target.exists() and not target.is_dir():
            raise SystemExit(f'cannot safely remove retired source path: {relative}')
        parent_directories.update(
            APP_DIR.joinpath(*parent.parts)
            for parent in pure.parents
            if parent != PurePosixPath('.')
        )

    for directory in sorted(
        parent_directories,
        key=lambda item: (len(item.relative_to(APP_DIR).parts), str(item)),
        reverse=True,
    ):
        relative = directory.relative_to(APP_DIR).as_posix()
        safe_directory = safe_source_target(relative)
        if (
            source_path_is_protected(relative)
            or not safe_directory.is_dir()
            or path_is_linklike(safe_directory)
        ):
            continue
        try:
            safe_directory.rmdir()
        except OSError:
            pass

    print(f'retired source files removed: {removed}', flush=True)
    return removed


def extract_archive(archive: Path) -> None:
    run([
        'tar',
        '--extract',
        '--gzip',
        '--file',
        str(archive),
        '--directory',
        str(APP_DIR),
        '--no-same-owner',
    ])


def parse_env_text(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip()
        if value[:1] == value[-1:] and value[:1] in {'"', "'"}:
            value = value[1:-1]
        if ENV_KEY_RE.fullmatch(key):
            values[key] = value
    return values


def set_data_owner(path: Path) -> None:
    chown = getattr(os, 'chown', None)
    if chown is None:
        return
    geteuid = getattr(os, 'geteuid', None)
    if geteuid is not None and geteuid() != 0:
        return
    chown(path, 10001, 10001)


def verify_sqlite_database(path: Path) -> None:
    source_uri = f'{path.resolve().as_uri()}?mode=ro'
    try:
        with closing(sqlite3.connect(source_uri, uri=True, timeout=30.0)) as database:
            result = database.execute('PRAGMA quick_check').fetchone()
    except (OSError, sqlite3.Error) as error:
        raise SystemExit(f'SQLite validation failed for {path}: {error}') from error
    if result != ('ok',):
        raise SystemExit(f'SQLite quick_check failed for {path}: {result!r}')


def copy_sqlite_database(source: Path, destination: Path, *, overwrite: bool = False) -> None:
    """Copy a consistent SQLite snapshot into an atomically replaced file."""

    if source.is_symlink() or not source.is_file():
        raise SystemExit(f'SQLite source is missing or unsafe: {source}')
    if destination.is_symlink() or (destination.exists() and not overwrite):
        raise SystemExit(f'SQLite destination already exists or is unsafe: {destination}')

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f'.{destination.name}.copy.tmp')
    temporary.unlink(missing_ok=True)
    try:
        source_uri = f'{source.resolve().as_uri()}?mode=ro'
        with closing(sqlite3.connect(source_uri, uri=True, timeout=30.0)) as source_db:
            with closing(sqlite3.connect(temporary, timeout=30.0)) as target_db:
                source_db.backup(target_db)
                result = target_db.execute('PRAGMA quick_check').fetchone()
                if result != ('ok',):
                    raise sqlite3.DatabaseError(f'quick_check failed: {result!r}')
        os.chmod(temporary, 0o600)
        set_data_owner(temporary)
        os.replace(temporary, destination)
    except (OSError, sqlite3.Error) as error:
        temporary.unlink(missing_ok=True)
        raise SystemExit(f'SQLite copy failed from {source} to {destination}: {error}') from error


def build_production_env(
    existing: dict[str, str],
    version: str,
    *,
    capability_secret: Optional[str] = None,
) -> dict[str, str]:
    if not VERSION_RE.fullmatch(version):
        raise ValueError('release version is not a valid Docker tag')

    turn_urls = existing.get('P2P_TURN_URLS', '')
    turn_secret = existing.get('P2P_TURN_SECRET', '')
    generated_capability = capability_secret or secrets.token_urlsafe(48)
    capability = existing.get('P2P_CAPABILITY_SECRET') or generated_capability
    ice_urls = existing.get('P2P_ICE_URLS') or 'stun:stun.l.google.com:19302'

    if not turn_urls:
        raise ValueError('P2P_TURN_URLS is missing')
    if len(turn_secret) < 16:
        raise ValueError('P2P_TURN_SECRET is missing or too short')
    if len(capability) < 32:
        raise ValueError('P2P_CAPABILITY_SECRET is too short')

    return {
        'P2P_IMAGE_TAG': version,
        'P2P_BIND_IP': '127.0.0.1',
        'P2P_BIND_PORT': '3410',
        'P2P_ALLOWED_ORIGINS': 'https://p2p.yxswy.com',
        'P2P_CAPABILITY_SECRET': capability,
        'P2P_TURN_SECRET': turn_secret,
        'P2P_TURN_URLS': turn_urls,
        'P2P_ICE_URLS': ice_urls,
        'P2P_SESSION_RATE_MAX': existing.get('P2P_SESSION_RATE_MAX', '60'),
        'P2P_ROOM_RATE_MAX': existing.get('P2P_ROOM_RATE_MAX', '60'),
        'P2P_JOIN_RATE_MAX': existing.get('P2P_JOIN_RATE_MAX', '120'),
        'P2P_SIGNAL_RATE_MAX': existing.get('P2P_SIGNAL_RATE_MAX', '600'),
        'RUST_LOG': existing.get('RUST_LOG', 'p2p_server=info,tower_http=info'),
    }


def format_env(values: dict[str, str]) -> str:
    lines: list[str] = []
    for key, value in values.items():
        if not ENV_KEY_RE.fullmatch(key):
            raise ValueError(f'invalid environment key: {key!r}')
        if '\n' in value or '\r' in value:
            raise ValueError(f'environment value for {key} contains a newline')
        lines.append(f'{key}={value}')
    return '\n'.join(lines) + '\n'


def prepare_production_environment(version: str, previous: bytes) -> None:
    existing = parse_env_text(previous.decode('utf-8'))

    if not existing:
        raise SystemExit('production environment is missing on the host')

    try:
        rendered = format_env(build_production_env(existing, version))
    except ValueError as error:
        raise SystemExit(str(error)) from error

    PRODUCTION_DATA.mkdir(parents=True, exist_ok=True)
    set_data_owner(PRODUCTION_DATA)
    os.chmod(PRODUCTION_DATA, 0o700)

    atomic_write_bytes(PRODUCTION_ENV, rendered.encode('utf-8'), 0o600)


def restore_production_environment(previous: bytes) -> None:
    atomic_write_bytes(PRODUCTION_ENV, previous, 0o600)


def production_database_runtime_files() -> tuple[Path, Path, Path]:
    return (
        PRODUCTION_DATABASE,
        Path(f'{PRODUCTION_DATABASE}-wal'),
        Path(f'{PRODUCTION_DATABASE}-shm'),
    )


def validate_production_database_restore_target() -> Optional[tuple[Path, Path, Path]]:
    deploy_root = APP_DIR / 'deploy'
    production_root = deploy_root / 'production'
    expected_data = production_root / 'data'
    expected_database = expected_data / 'control.sqlite3'
    if PRODUCTION_DATA != expected_data or PRODUCTION_DATABASE != expected_database:
        print('production database rollback path does not match the deployment layout', flush=True)
        return None
    for directory in (APP_DIR, deploy_root, production_root, expected_data):
        if path_is_linklike(directory) or not directory.is_dir():
            print(f'production database rollback directory is unsafe: {directory}', flush=True)
            return None
    runtime_files = production_database_runtime_files()
    for path in runtime_files:
        if path_is_linklike(path):
            print(f'production database rollback target is unsafe: {path}', flush=True)
            return None
        if path.exists() and not path.is_file():
            print(f'production database rollback target is not a regular file: {path}', flush=True)
            return None
    return runtime_files


def remove_production_database_files(paths: tuple[Path, ...]) -> bool:
    try:
        for path in paths:
            path.unlink(missing_ok=True)
        if paths:
            fsync_directory(paths[0].parent)
    except OSError as error:
        print(f'production database file removal failed: {error}', flush=True)
        return False
    return True


def fsync_file(path: Path) -> None:
    # Windows requires a writable descriptor for FlushFileBuffers; production
    # Linux accepts this mode as well, and these are root-owned restore files.
    with path.open('r+b') as source:
        os.fsync(source.fileno())


def fsync_directory(path: Path) -> None:
    if os.name == 'nt':
        return
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def database_restore_recovery_artifacts(database: Path) -> list[Path]:
    patterns = (
        f'.{database.name}.restore-*',
        f'.{database.name}.rollback-*',
    )
    return [path for pattern in patterns for path in database.parent.glob(pattern)]


def install_prepared_database(backup: Path, runtime_files: tuple[Path, Path, Path]) -> bool:
    database, _, _ = runtime_files
    recovery_artifacts = database_restore_recovery_artifacts(database)
    if recovery_artifacts:
        print(
            'production database recovery artifacts require manual reconciliation: '
            + ', '.join(str(path) for path in recovery_artifacts),
            flush=True,
        )
        return False

    token = secrets.token_hex(16)
    prepared = database.parent / f'.{database.name}.restore-{token}'
    quarantines = {
        path: database.parent / f'.{database.name}.rollback-{token}-{suffix}'
        for path, suffix in zip(runtime_files, ('main', 'wal', 'shm'))
    }
    try:
        # Fully materialize, quick-check and sync the previous database before
        # changing any current main/WAL/SHM file.
        copy_sqlite_database(backup, prepared)
        verify_sqlite_database(prepared)
        fsync_file(prepared)
        fsync_directory(database.parent)
    except (OSError, SystemExit) as error:
        prepared.unlink(missing_ok=True)
        print(f'production database restore preparation failed: {error}', flush=True)
        return False

    moved: list[tuple[Path, Path]] = []
    installed = False
    try:
        for current, quarantine in quarantines.items():
            if current.exists():
                os.replace(current, quarantine)
                moved.append((current, quarantine))
        os.replace(prepared, database)
        installed = True
        fsync_directory(database.parent)
        verify_sqlite_database(database)
        fsync_file(database)
    except (OSError, SystemExit) as error:
        restored = True
        try:
            moved_sources = {current for current, _ in moved}
            if installed:
                for current in runtime_files:
                    if current not in moved_sources:
                        current.unlink(missing_ok=True)
            for current, quarantine in reversed(moved):
                os.replace(quarantine, current)
            fsync_directory(database.parent)
        except OSError as restore_error:
            restored = False
            print(
                f'production database quarantine restore failed: {restore_error}',
                flush=True,
            )
        prepared.unlink(missing_ok=True)
        state = 'original files restored' if restored else 'manual recovery required'
        print(f'production database install failed ({state}): {error}', flush=True)
        return False

    try:
        for quarantine in quarantines.values():
            quarantine.unlink(missing_ok=True)
        fsync_directory(database.parent)
    except OSError as error:
        print(
            'production database was restored but quarantine cleanup failed; '
            f'manual recovery is required: {error}',
            flush=True,
        )
        return False
    return True


def restore_production_database(backup: Optional[Path]) -> bool:
    runtime_files = validate_production_database_restore_target()
    if runtime_files is None:
        return False
    database, _, _ = runtime_files
    recovery_artifacts = database_restore_recovery_artifacts(database)
    if recovery_artifacts:
        print(
            'production database recovery artifacts require manual reconciliation: '
            + ', '.join(str(path) for path in recovery_artifacts),
            flush=True,
        )
        return False
    if backup is None:
        # A missing backup is an explicit record that the database did not
        # exist before this release.  The staged application may have created
        # one (including WAL sidecars) during readiness checks, so rollback
        # must restore the same absence instead of leaving target state behind.
        if not remove_production_database_files(runtime_files):
            return False
        print('production database absence restored', flush=True)
        return True
    if path_is_linklike(backup) or not backup.is_file():
        print(f'production database rollback backup is missing or unsafe: {backup}', flush=True)
        return False
    if not install_prepared_database(backup, runtime_files):
        return False
    print(f'production database restored from {backup}', flush=True)
    return True


def require_rollback_image(previous_tag: Optional[str]) -> str:
    if not previous_tag or not VERSION_RE.fullmatch(previous_tag):
        raise SystemExit('previous production image tag is missing or invalid')
    image = f'p2p-transmission:{previous_tag}'
    if not image_exists(image):
        raise SystemExit(f'previous production image is unavailable: {image}')
    return image


def preserve_rollback_image(image: str) -> None:
    run(['docker', 'image', 'tag', image, 'p2p-transmission:previous'])


def ensure_rollback_directory() -> Path:
    deploy_root = APP_DIR / 'deploy'
    production_root = deploy_root / 'production'
    expected_rollback = production_root / 'rollback'
    if PRODUCTION_ROLLBACK != expected_rollback:
        raise SystemExit('production rollback directory does not match the deployment layout')
    for directory in (APP_DIR, deploy_root, production_root):
        if path_is_linklike(directory) or not directory.is_dir():
            raise SystemExit(f'production rollback ancestor is unsafe: {directory}')
    if path_is_linklike(PRODUCTION_ROLLBACK):
        raise SystemExit('production rollback directory must not be a symbolic link')
    try:
        PRODUCTION_ROLLBACK.mkdir(parents=True, exist_ok=True)
        rollback_root = PRODUCTION_ROLLBACK.resolve()
    except OSError as error:
        raise SystemExit(f'cannot prepare the production rollback directory: {error}') from error
    if rollback_root.parent != production_root:
        raise SystemExit('production rollback directory escapes the deployment directory')
    os.chmod(rollback_root, 0o700)
    return rollback_root


def snapshot_runtime_file(source: Path, prefix: str) -> Path:
    if path_is_linklike(source) or not source.is_file():
        raise SystemExit(f'production rollback source is missing or unsafe: {source}')
    rollback_root = ensure_rollback_directory()
    descriptor, name = tempfile.mkstemp(prefix=prefix, dir=rollback_root)
    snapshot = Path(name)
    try:
        with source.open('rb') as source_file, os.fdopen(descriptor, 'wb') as destination:
            shutil.copyfileobj(source_file, destination)
            destination.flush()
            os.fsync(destination.fileno())
        os.chmod(snapshot, 0o600)
        fsync_directory(rollback_root)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        snapshot.unlink(missing_ok=True)
        raise
    return snapshot


def restore_runtime_file(snapshot: Path, target: Path, mode: int) -> bool:
    if path_is_linklike(snapshot) or not snapshot.is_file():
        return False
    descriptor: Optional[int] = None
    temporary: Optional[Path] = None
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix=f'.{target.name}.restore-', dir=target.parent)
        temporary = Path(name)
        with snapshot.open('rb') as source, os.fdopen(descriptor, 'wb') as destination:
            descriptor = None
            shutil.copyfileobj(source, destination)
        os.chmod(temporary, mode)
        os.replace(temporary, target)
        return True
    except OSError as error:
        print(f'production file restore failed for {target}: {error}', flush=True)
        return False
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def snapshot_nginx() -> Path:
    return snapshot_runtime_file(NGINX_TARGET, NGINX_SNAPSHOT_PREFIX)


def snapshot_compose() -> Path:
    return snapshot_runtime_file(PRODUCTION_COMPOSE, COMPOSE_SNAPSHOT_PREFIX)


def backup_production_database(version: str) -> Optional[Path]:
    """Create and verify a consistent SQLite backup before changing the runtime."""
    if validate_production_database_restore_target() is None:
        raise SystemExit('production database layout is unsafe for backup')
    recovery_artifacts = database_restore_recovery_artifacts(PRODUCTION_DATABASE)
    if recovery_artifacts:
        raise SystemExit(
            'production database recovery artifacts require manual reconciliation: '
            + ', '.join(str(path) for path in recovery_artifacts)
        )
    if not PRODUCTION_DATABASE.is_file():
        print('production database is not present; backup is not required', flush=True)
        return None

    backup_root = PRODUCTION_BACKUPS
    expected_root = APP_DIR / 'deploy/production/backups'
    if backup_root != expected_root or path_is_linklike(backup_root):
        raise SystemExit('database backup directory is unsafe')
    backup_root.mkdir(parents=True, exist_ok=True)
    if path_is_linklike(backup_root) or not backup_root.is_dir():
        raise SystemExit('database backup directory is unsafe')
    os.chmod(backup_root, 0o700)
    existing_backups = sorted(backup_root.glob('control-*.sqlite3'), reverse=True)
    if any(
        path_is_linklike(backup) or not backup.is_file()
        for backup in existing_backups
    ):
        raise SystemExit('database backup cleanup encountered an unsafe path')

    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    destination = backup_root / f'control-{timestamp}-{version}.sqlite3'
    if path_is_linklike(destination) or destination.exists():
        raise SystemExit('database backup destination already exists or is unsafe')
    try:
        source_uri = f'{PRODUCTION_DATABASE.resolve().as_uri()}?mode=ro'
        with closing(sqlite3.connect(source_uri, uri=True, timeout=30.0)) as source:
            with closing(sqlite3.connect(destination, timeout=30.0)) as target:
                source.backup(target)
                result = target.execute('PRAGMA quick_check').fetchone()
                if result != ('ok',):
                    raise sqlite3.DatabaseError(f'backup quick_check failed: {result!r}')
        os.chmod(destination, 0o600)
        fsync_file(destination)
        fsync_directory(backup_root)
    except (OSError, sqlite3.Error) as error:
        destination.unlink(missing_ok=True)
        raise SystemExit(f'production database backup failed: {error}') from error

    backups = sorted((*existing_backups, destination), reverse=True)
    for old_backup in backups[DATABASE_BACKUP_LIMIT:]:
        old_backup.unlink()
    fsync_directory(backup_root)

    print(f'production database backup ready: {destination}', flush=True)
    return destination


def install_production_nginx() -> None:
    if path_is_linklike(NGINX_SOURCE) or not NGINX_SOURCE.is_file():
        raise SystemExit('production Nginx configuration is missing')
    atomic_write_bytes(NGINX_TARGET, NGINX_SOURCE.read_bytes(), 0o644)
    run(['nginx', '-t'])
    run(['systemctl', 'reload', 'nginx'])


def restore_nginx(snapshot: Path) -> bool:
    if not restore_runtime_file(snapshot, NGINX_TARGET, 0o644):
        return False
    return best_effort(['nginx', '-t']) and best_effort(['systemctl', 'reload', 'nginx'])


def restore_compose(snapshot: Path) -> bool:
    return restore_runtime_file(snapshot, PRODUCTION_COMPOSE, 0o644)


def readiness_matches(payload: object, expected_release: str) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get('status') == 'ready'
        and payload.get('service') == 'p2p-server'
        and payload.get('release') == expected_release
    )


def wait_for_readiness(expected_release: str) -> bool:
    url = 'http://127.0.0.1:3410/health/ready'
    for _ in range(45):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                payload = json.loads(response.read().decode('utf-8'))
            if response.status == 200 and readiness_matches(
                payload,
                expected_release,
            ):
                actual = payload.get('release')
                print(f'production ready: {actual}', flush=True)
                return True
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        time.sleep(2)
    return False


def wait_for_production_ready(expected_release: str) -> None:
    if wait_for_readiness(expected_release):
        return
    run(compose_production('ps'))
    run(compose_production('logs', '--tail=200', 'app'))
    raise SystemExit('production readiness check failed')


def current_production_release() -> Optional[str]:
    url = 'http://127.0.0.1:3410/health/ready'
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            payload = json.loads(response.read().decode('utf-8'))
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return None
    if (
        response.status != 200
        or not isinstance(payload, dict)
        or payload.get('status') != 'ready'
        or payload.get('service') != 'p2p-server'
    ):
        return None
    release = payload.get('release')
    return release if isinstance(release, str) and VERSION_RE.fullmatch(release) else None


def production_runtime_matches(version: str) -> bool:
    if not running_production_release_matches(version):
        return False
    try:
        values = parse_env_text(PRODUCTION_ENV.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError):
        return False
    return values.get('P2P_IMAGE_TAG') == version


def running_production_release_matches(version: str) -> bool:
    if not VERSION_RE.fullmatch(version) or current_production_release() != version:
        return False
    expected_image_id = image_id(f'p2p-transmission:{version}')
    return expected_image_id is not None and running_production_image_id() == expected_image_id


def require_sha256(value: str, label: str) -> str:
    if not SHA256_RE.fullmatch(value):
        raise SystemExit(f'{label} SHA-256 is invalid')
    return value


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''):
                digest.update(chunk)
    except OSError as error:
        raise SystemExit(f'cannot hash production runtime file {path}: {error}') from error
    return digest.hexdigest()


def require_runtime_file_hash(path: Path, expected: str, label: str) -> None:
    expected = require_sha256(expected, label)
    if path_is_linklike(path) or not path.is_file():
        raise SystemExit(f'legacy {label} runtime file is missing or unsafe')
    if file_sha256(path) != expected:
        raise SystemExit(f'legacy {label} runtime file changed across the helper migration')


def cleanup_snapshot_paths(*snapshots: Path) -> bool:
    cleaned = True
    for snapshot in snapshots:
        try:
            snapshot.unlink(missing_ok=True)
        except OSError as error:
            print(f'rollback snapshot cleanup failed for {snapshot}: {error}', flush=True)
            cleaned = False
    return cleaned


@dataclass(frozen=True)
class ProductionPreflight:
    previous_env: bytes
    previous_tag: str
    database_backup: Optional[Path]
    nginx_snapshot: Path
    compose_snapshot: Path
    expected_image: str
    database_may_have_changed: bool = False
    rollback_database_restored: bool = False

    def cleanup_snapshots(self) -> bool:
        return cleanup_snapshot_paths(self.nginx_snapshot, self.compose_snapshot)


def ensure_no_pending_release() -> None:
    if PENDING_RELEASE.exists() or path_is_linklike(PENDING_RELEASE):
        raise SystemExit(
            'another production release is pending; finalize or roll it back before staging'
        )


def pending_snapshot_path(raw_path: object, prefix: str, label: str) -> Path:
    if not isinstance(raw_path, str):
        raise SystemExit(f'pending release {label} path is invalid')
    candidate = Path(raw_path)
    try:
        rollback_root = ensure_rollback_directory()
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise SystemExit(f'pending release {label} snapshot is unavailable: {error}') from error
    if (
        resolved.parent != rollback_root
        or not resolved.name.startswith(prefix)
        or path_is_linklike(candidate)
        or not resolved.is_file()
    ):
        raise SystemExit(f'pending release {label} snapshot is missing or unsafe')
    return resolved


def pending_database_backup_path(raw_path: object) -> Optional[Path]:
    if raw_path is None:
        return None
    if not isinstance(raw_path, str):
        raise SystemExit('pending release database backup path is invalid')
    candidate = Path(raw_path)
    try:
        backup_root = PRODUCTION_BACKUPS.resolve(strict=True)
        resolved = candidate.resolve(strict=True)
        metadata = resolved.stat()
    except OSError as error:
        raise SystemExit(f'pending release database backup is unavailable: {error}') from error
    if (
        resolved.parent != backup_root
        or path_is_linklike(candidate)
        or not resolved.is_file()
        or (os.name != 'nt' and stat.S_IMODE(metadata.st_mode) & 0o077)
    ):
        raise SystemExit('pending release database backup is missing or unsafe')
    return resolved


def persist_pending_release(
    preflight: ProductionPreflight,
    version: str,
    *,
    require_absent: bool,
) -> None:
    if require_absent:
        ensure_no_pending_release()
    ensure_rollback_directory()
    payload = {
        'schema': PENDING_RELEASE_SCHEMA,
        'release_version': version,
        'previous_environment': base64.b64encode(preflight.previous_env).decode('ascii'),
        'previous_tag': preflight.previous_tag,
        'database_backup': (
            str(preflight.database_backup) if preflight.database_backup is not None else None
        ),
        'nginx_snapshot': str(preflight.nginx_snapshot),
        'compose_snapshot': str(preflight.compose_snapshot),
        'database_may_have_changed': preflight.database_may_have_changed,
        'rollback_database_restored': preflight.rollback_database_restored,
    }
    rendered = (json.dumps(payload, sort_keys=True) + '\n').encode('utf-8')
    atomic_write_bytes(PENDING_RELEASE, rendered, 0o600)


def write_pending_release(preflight: ProductionPreflight, version: str) -> None:
    persist_pending_release(preflight, version, require_absent=True)
    print(f'production release {version} is staged pending public verification', flush=True)


def mark_pending_database_may_have_changed(version: str) -> ProductionPreflight:
    preflight = load_pending_release(version)
    if preflight.database_may_have_changed:
        return preflight
    updated = replace(preflight, database_may_have_changed=True)
    persist_pending_release(updated, version, require_absent=False)
    print(f'production release {version} entered the runtime switch phase', flush=True)
    return updated


def mark_pending_rollback_database_restored(version: str) -> ProductionPreflight:
    preflight = load_pending_release(version)
    if not preflight.database_may_have_changed:
        raise SystemExit('cannot mark a database restore before the runtime switch phase')
    if preflight.rollback_database_restored:
        return preflight
    updated = replace(preflight, rollback_database_restored=True)
    persist_pending_release(updated, version, require_absent=False)
    print(f'production release {version} recorded its database rollback', flush=True)
    return updated


def legacy_operation_database_backup(payload: dict[str, object], version: str) -> Optional[Path]:
    backup_not_required = payload.get('database_backup_not_required')
    raw_backup = payload.get('database_backup')
    if backup_not_required is True:
        if raw_backup is not None:
            raise SystemExit('legacy operation database backup state is contradictory')
        return None
    if backup_not_required is not False or not isinstance(raw_backup, str):
        raise SystemExit('legacy operation did not record its database backup')
    candidate = Path(raw_backup)
    try:
        backup_root = PRODUCTION_BACKUPS.resolve(strict=True)
        resolved = candidate.resolve(strict=True)
        metadata = resolved.stat()
    except OSError as error:
        raise SystemExit(f'legacy production database backup is unavailable: {error}') from error
    expected_parent = (APP_DIR / 'deploy/production').resolve()
    if (
        backup_root.parent != expected_parent
        or resolved.parent != backup_root
        or path_is_linklike(PRODUCTION_BACKUPS)
        or path_is_linklike(candidate)
        or not resolved.is_file()
        or not resolved.name.endswith(f'-{version}.sqlite3')
        or (os.name != 'nt' and stat.S_IMODE(metadata.st_mode) & 0o077)
    ):
        raise SystemExit('legacy production database backup is missing or unsafe')
    verify_sqlite_database(resolved)
    return resolved


def load_legacy_operation(path: Path, version: str) -> dict[str, object]:
    operation = validate_tmp_file(path, LEGACY_OPERATION_RE, 'legacy operation state')
    operation_match = LEGACY_OPERATION_RE.fullmatch(operation.name)
    if operation_match is None:
        raise SystemExit('legacy operation state name is invalid')
    try:
        metadata = operation.stat()
        payload = json.loads(operation.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f'cannot read legacy operation state: {error}') from error
    exit_code = payload.get('exit_code') if isinstance(payload, dict) else None
    if (
        (os.name != 'nt' and stat.S_IMODE(metadata.st_mode) & 0o077)
        or metadata.st_size > PENDING_RELEASE_MAX_BYTES
        or not isinstance(payload, dict)
        or payload.get('schema') != 1
        or payload.get('operation_id') != operation_match.group(1)
        or payload.get('version') != version
        or payload.get('mode') != 'legacy'
        or isinstance(exit_code, bool)
        or not isinstance(exit_code, int)
        or not 0 <= exit_code <= 255
        or payload.get('finished') is not True
    ):
        raise SystemExit('legacy operation state is incomplete or unsafe')
    return payload


def protect_legacy_runtime_snapshot(
    path: Path,
    pattern: re.Pattern[str],
    expected_sha256: str,
    prefix: str,
    label: str,
) -> Path:
    source = validate_tmp_file(path, pattern, f'legacy {label} snapshot')
    metadata = source.stat()
    if os.name != 'nt' and stat.S_IMODE(metadata.st_mode) & 0o077:
        raise SystemExit(f'legacy {label} snapshot permissions are unsafe')
    require_runtime_file_hash(source, expected_sha256, label)
    protected = snapshot_runtime_file(source, prefix)
    try:
        require_runtime_file_hash(protected, expected_sha256, label)
    except BaseException:
        protected.unlink(missing_ok=True)
        raise
    return protected


def adopt_legacy_pending_release(
    version: str,
    previous_version: str,
    operation_state: Path,
    compose_snapshot_source: Path,
    nginx_snapshot_source: Path,
    compose_sha256: str,
    nginx_sha256: str,
) -> None:
    if not VERSION_RE.fullmatch(version) or not VERSION_RE.fullmatch(previous_version):
        raise SystemExit('release version contains unsupported characters')
    if version == previous_version:
        raise SystemExit('legacy deployment must identify a different previous version')
    operation_match = LEGACY_OPERATION_RE.fullmatch(operation_state.name)
    compose_match = LEGACY_COMPOSE_RE.fullmatch(compose_snapshot_source.name)
    nginx_match = LEGACY_NGINX_RE.fullmatch(nginx_snapshot_source.name)
    operation_ids = {
        match.group(1)
        for match in (operation_match, compose_match, nginx_match)
        if match is not None
    }
    if (
        operation_match is None
        or compose_match is None
        or nginx_match is None
        or len(operation_ids) != 1
    ):
        raise SystemExit('legacy migration artifacts do not share one operation id')
    ensure_no_pending_release()
    operation = load_legacy_operation(operation_state, version)
    if not production_runtime_matches(version):
        raise SystemExit('legacy production runtime does not consistently run the target version')
    previous_image = require_rollback_image(previous_version)
    previous_image_id = image_id(previous_image)
    if previous_image_id is None or image_id('p2p-transmission:previous') != previous_image_id:
        raise SystemExit('legacy rollback image does not match the previous production image')

    try:
        current_env = PRODUCTION_ENV.read_bytes()
        current_values = parse_env_text(current_env.decode('utf-8'))
    except (OSError, UnicodeDecodeError) as error:
        raise SystemExit(f'cannot read the legacy production environment: {error}') from error
    if current_values.get('P2P_IMAGE_TAG') != version:
        raise SystemExit('legacy production environment does not match the deployed version')
    try:
        previous_env = format_env(
            build_production_env(current_values, previous_version)
        ).encode('utf-8')
    except ValueError as error:
        raise SystemExit(str(error)) from error

    database_backup = legacy_operation_database_backup(operation, version)
    nginx_snapshot: Optional[Path] = None
    compose_snapshot: Optional[Path] = None
    try:
        nginx_snapshot = protect_legacy_runtime_snapshot(
            nginx_snapshot_source,
            LEGACY_NGINX_RE,
            nginx_sha256,
            NGINX_SNAPSHOT_PREFIX,
            'Nginx',
        )
        compose_snapshot = protect_legacy_runtime_snapshot(
            compose_snapshot_source,
            LEGACY_COMPOSE_RE,
            compose_sha256,
            COMPOSE_SNAPSHOT_PREFIX,
            'Compose',
        )
        preflight = ProductionPreflight(
            previous_env=previous_env,
            previous_tag=previous_version,
            database_backup=database_backup,
            nginx_snapshot=nginx_snapshot,
            compose_snapshot=compose_snapshot,
            expected_image=f'p2p-transmission:{version}',
            database_may_have_changed=True,
        )
        write_pending_release(preflight, version)
    except BaseException:
        cleanup_snapshot_paths(
            *(snapshot for snapshot in (nginx_snapshot, compose_snapshot) if snapshot is not None)
        )
        raise
    print(f'legacy production release adopted for public verification: {version}', flush=True)


def load_pending_release(expected_version: str) -> ProductionPreflight:
    if not VERSION_RE.fullmatch(expected_version):
        raise SystemExit('release version contains unsupported characters')
    try:
        rollback_root = ensure_rollback_directory()
        resolved = PENDING_RELEASE.resolve(strict=True)
        metadata = PENDING_RELEASE.stat()
    except OSError as error:
        raise SystemExit(f'pending production release is unavailable: {error}') from error
    if (
        resolved.parent != rollback_root
        or path_is_linklike(PENDING_RELEASE)
        or not resolved.is_file()
        or (os.name != 'nt' and stat.S_IMODE(metadata.st_mode) & 0o077)
        or metadata.st_size > PENDING_RELEASE_MAX_BYTES
    ):
        raise SystemExit('pending production release state is missing or unsafe')
    try:
        payload = json.loads(resolved.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f'cannot read pending production release: {error}') from error
    if not isinstance(payload, dict) or payload.get('schema') != PENDING_RELEASE_SCHEMA:
        raise SystemExit('pending production release schema is unsupported')
    if payload.get('release_version') != expected_version:
        raise SystemExit('pending production release does not match the requested version')

    previous_tag = payload.get('previous_tag')
    encoded_environment = payload.get('previous_environment')
    if not isinstance(previous_tag, str) or not VERSION_RE.fullmatch(previous_tag):
        raise SystemExit('pending production release previous tag is invalid')
    if not isinstance(encoded_environment, str):
        raise SystemExit('pending production release environment is invalid')
    try:
        previous_env = base64.b64decode(encoded_environment, validate=True)
        previous_values = parse_env_text(previous_env.decode('utf-8'))
    except (binascii.Error, UnicodeDecodeError) as error:
        raise SystemExit('pending production release environment is invalid') from error
    if previous_values.get('P2P_IMAGE_TAG') != previous_tag:
        raise SystemExit('pending production release environment tag does not match its metadata')
    database_may_have_changed = payload.get('database_may_have_changed')
    if not isinstance(database_may_have_changed, bool):
        raise SystemExit('pending production release runtime phase is invalid')
    rollback_database_restored = payload.get('rollback_database_restored')
    if (
        not isinstance(rollback_database_restored, bool)
        or (rollback_database_restored and not database_may_have_changed)
    ):
        raise SystemExit('pending production release rollback phase is invalid')

    return ProductionPreflight(
        previous_env=previous_env,
        previous_tag=previous_tag,
        database_backup=pending_database_backup_path(payload.get('database_backup')),
        nginx_snapshot=pending_snapshot_path(
            payload.get('nginx_snapshot'), NGINX_SNAPSHOT_PREFIX, 'Nginx'
        ),
        compose_snapshot=pending_snapshot_path(
            payload.get('compose_snapshot'), COMPOSE_SNAPSHOT_PREFIX, 'Compose'
        ),
        expected_image=f'p2p-transmission:{expected_version}',
        database_may_have_changed=database_may_have_changed,
        rollback_database_restored=rollback_database_restored,
    )


def close_pending_release(preflight: ProductionPreflight) -> None:
    try:
        PENDING_RELEASE.unlink()
    except OSError as error:
        raise SystemExit(f'cannot clear pending production release state: {error}') from error
    preflight.cleanup_snapshots()


def finalize_pending_release(version: str) -> None:
    preflight = load_pending_release(version)
    wait_for_production_ready(version)
    close_pending_release(preflight)
    print(f'production release finalized: {preflight.expected_image}', flush=True)


def rollback_pending_release(
    version: str,
    *,
    bootstrap_previous_version: Optional[str] = None,
    bootstrap_operation_state: Optional[Path] = None,
    bootstrap_compose_snapshot: Optional[Path] = None,
    bootstrap_nginx_snapshot: Optional[Path] = None,
    bootstrap_compose_sha256: Optional[str] = None,
    bootstrap_nginx_sha256: Optional[str] = None,
) -> None:
    if not PENDING_RELEASE.exists():
        if path_is_linklike(PENDING_RELEASE):
            raise SystemExit('pending production release state is missing or unsafe')
        bootstrap_values = (
            bootstrap_previous_version,
            bootstrap_operation_state,
            bootstrap_compose_snapshot,
            bootstrap_nginx_snapshot,
            bootstrap_compose_sha256,
            bootstrap_nginx_sha256,
        )
        if any(value is not None for value in bootstrap_values):
            if not all(value is not None for value in bootstrap_values):
                raise SystemExit('legacy rollback context is incomplete')
            assert bootstrap_previous_version is not None
            assert bootstrap_operation_state is not None
            assert bootstrap_compose_snapshot is not None
            assert bootstrap_nginx_snapshot is not None
            assert bootstrap_compose_sha256 is not None
            assert bootstrap_nginx_sha256 is not None
            load_legacy_operation(bootstrap_operation_state, version)
            if production_runtime_matches(bootstrap_previous_version):
                print(
                    f'legacy production release already runs {bootstrap_previous_version}',
                    flush=True,
                )
                return
            if not production_runtime_matches(version):
                raise SystemExit(
                    'cannot reconcile a mixed or unavailable legacy production runtime'
                )
            adopt_legacy_pending_release(
                version,
                bootstrap_previous_version,
                bootstrap_operation_state,
                bootstrap_compose_snapshot,
                bootstrap_nginx_snapshot,
                bootstrap_compose_sha256,
                bootstrap_nginx_sha256,
            )
        else:
            print(f'no pending production release to roll back for {version}', flush=True)
            return
    preflight = load_pending_release(version)
    rollback_recorded_release(preflight)
    close_pending_release(preflight)
    print(f'production release rolled back from {preflight.expected_image}', flush=True)


def preflight_production(image_archive: Path, version: str) -> ProductionPreflight:
    if not PRODUCTION_ENV.is_file():
        raise SystemExit('production environment is missing on the host')
    try:
        previous_env = PRODUCTION_ENV.read_bytes()
        previous_env_values = parse_env_text(previous_env.decode('utf-8'))
    except (OSError, UnicodeDecodeError) as error:
        raise SystemExit(f'cannot read the production environment: {error}') from error

    previous_tag = previous_env_values.get('P2P_IMAGE_TAG')
    previous_image = require_rollback_image(previous_tag)
    if previous_tag is None:
        raise SystemExit('previous production image tag is missing')
    expected_image = f'p2p-transmission:{version}'

    nginx_snapshot: Optional[Path] = None
    compose_snapshot: Optional[Path] = None
    try:
        run(compose_production('config', '--quiet'))
        preserve_rollback_image(previous_image)
        nginx_snapshot = snapshot_nginx()
        compose_snapshot = snapshot_compose()
        database_backup = backup_production_database(version)
        run(['docker', 'load', '--input', str(image_archive)])
        if not image_exists(expected_image):
            raise SystemExit(f'image archive did not contain {expected_image}')
    except BaseException:
        cleanup_snapshot_paths(
            *(snapshot for snapshot in (nginx_snapshot, compose_snapshot) if snapshot is not None)
        )
        raise

    if nginx_snapshot is None or compose_snapshot is None:
        raise SystemExit('production rollback snapshots were not created')

    return ProductionPreflight(
        previous_env=previous_env,
        previous_tag=previous_tag,
        database_backup=database_backup,
        nginx_snapshot=nginx_snapshot,
        compose_snapshot=compose_snapshot,
        expected_image=expected_image,
    )


def preflight_release_version(preflight: ProductionPreflight) -> str:
    prefix = 'p2p-transmission:'
    if not preflight.expected_image.startswith(prefix):
        raise SystemExit('pending production release image is invalid')
    version = preflight.expected_image[len(prefix) :]
    if not VERSION_RE.fullmatch(version):
        raise SystemExit('pending production release version is invalid')
    return version


def rollback_runtime(preflight: ProductionPreflight) -> None:
    environment_restored = True
    try:
        restore_production_environment(preflight.previous_env)
    except OSError as error:
        print(f'production environment restore failed: {error}', flush=True)
        environment_restored = False

    compose_restored = restore_compose(preflight.compose_snapshot)
    nginx_restored = restore_nginx(preflight.nginx_snapshot)
    stopped = False
    removed = False
    database_restored = preflight.rollback_database_restored
    if environment_restored and compose_restored and nginx_restored:
        stopped = best_effort(compose_production('stop', 'app'))
        removed = stopped and best_effort(compose_production('rm', '--force', 'app'))
        if removed and not database_restored:
            database_restored = restore_production_database(preflight.database_backup)
            if database_restored:
                # Persist this boundary before the old container can accept
                # writes. A retry must never replay the backup after this bit.
                mark_pending_rollback_database_restored(
                    preflight_release_version(preflight)
                )

    prerequisites_restored = all(
        (
            environment_restored,
            compose_restored,
            nginx_restored,
            stopped,
            removed,
            database_restored,
        )
    )
    runtime_restored = False
    if prerequisites_restored:
        runtime_restored = best_effort(
            compose_production('up', '-d', '--no-build', '--no-deps', 'app')
        ) and wait_for_readiness(preflight.previous_tag)

    if not prerequisites_restored or not runtime_restored:
        raise SystemExit('automatic production rollback failed; manual intervention is required')


def restore_pre_runtime_state(preflight: ProductionPreflight) -> None:
    """Abort before a target container could touch the production database."""

    environment_restored = True
    try:
        restore_production_environment(preflight.previous_env)
    except OSError as error:
        print(f'production environment restore failed: {error}', flush=True)
        environment_restored = False
    compose_restored = restore_compose(preflight.compose_snapshot)
    nginx_restored = restore_nginx(preflight.nginx_snapshot)
    runtime_unchanged = (
        environment_restored
        and compose_restored
        and nginx_restored
        and production_runtime_matches(preflight.previous_tag)
    )
    if not runtime_unchanged:
        raise SystemExit(
            'pre-runtime production abort could not prove the previous runtime unchanged; '
            'manual intervention is required'
        )
    print(
        'production release aborted before the database could be changed; '
        'the running container was left untouched',
        flush=True,
    )


def rollback_recorded_release(preflight: ProductionPreflight) -> None:
    # The phase marker is persisted immediately before `docker compose up`.
    # Even after that marker, a failed `up` may have left the verified previous
    # container running.  In that case a full database restore would discard
    # writes made after the preflight backup, so only restore runtime files.
    if (
        not preflight.database_may_have_changed
        or running_production_release_matches(preflight.previous_tag)
    ):
        restore_pre_runtime_state(preflight)
        return
    rollback_runtime(preflight)


def deploy_production(preflight: ProductionPreflight, version: str) -> None:
    try:
        # Record rollback state before changing the environment, container, or Nginx.
        # This lets the workflow recover when SSH disconnects after the remote
        # process started but before its exit status reached GitHub Actions.
        write_pending_release(preflight, version)
        prepare_production_environment(version, preflight.previous_env)
        run(compose_production('config', '--quiet'))
        # Persist the conservative database boundary immediately before the
        # first command that may recreate the application container.
        mark_pending_database_may_have_changed(version)
        run(compose_production('up', '-d', '--no-build', '--no-deps', 'app'))
        wait_for_production_ready(version)
        install_production_nginx()
    except BaseException as release_error:
        print('production release failed; reconciling the recorded production phase', flush=True)
        try:
            if PENDING_RELEASE.exists() or path_is_linklike(PENDING_RELEASE):
                recorded = load_pending_release(version)
                rollback_recorded_release(recorded)
                close_pending_release(recorded)
            else:
                # Source extraction has already replaced the Compose source,
                # but a failed marker write proves no runtime command began.
                restore_pre_runtime_state(preflight)
                preflight.cleanup_snapshots()
        except BaseException as rollback_error:
            raise SystemExit(f'production release and rollback failed: {rollback_error}') from release_error
        raise


def deploy(
    archive: Path,
    version: str,
    image_archive: Path,
    retired_files: Path,
) -> None:
    if not VERSION_RE.fullmatch(version):
        raise SystemExit('release version contains unsupported characters')
    ensure_no_pending_release()
    archive = validate_source_archive(archive)
    image = validate_image_archive(image_archive)
    retired_path, bootstrap_files = validate_retired_files(retired_files)
    current_files = source_archive_files(archive)
    try:
        preflight = preflight_production(image, version)
        try:
            extract_archive(archive)
            remove_retired_source_files(current_files, bootstrap_files)
            write_source_manifest(current_files)
        except BaseException as source_error:
            compose_restored = restore_compose(preflight.compose_snapshot)
            preflight.cleanup_snapshots()
            if not compose_restored:
                raise SystemExit(
                    'source release failed and the previous Compose file could not be restored'
                ) from source_error
            raise
        deploy_production(preflight, version)
    finally:
        archive.unlink(missing_ok=True)
        image.unlink(missing_ok=True)
        retired_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    actions = parser.add_subparsers(dest='action', required=True)
    actions.add_parser('protocol-version', help='print the deployment helper protocol')
    stage = actions.add_parser('stage', help='switch production and retain rollback state')
    stage.add_argument('--archive', required=True, type=Path)
    stage.add_argument('--version', required=True)
    stage.add_argument('--image-archive', required=True, type=Path)
    stage.add_argument('--retired-files', required=True, type=Path)
    finalize = actions.add_parser('finalize', help='accept a publicly verified release')
    finalize.add_argument('--version', required=True)
    adopt = actions.add_parser(
        'adopt-legacy',
        help='retain rollback state after the one-time legacy helper migration',
    )
    adopt.add_argument('--version', required=True)
    adopt.add_argument('--previous-version', required=True)
    adopt.add_argument('--operation-state', required=True, type=Path)
    adopt.add_argument('--compose-snapshot', required=True, type=Path)
    adopt.add_argument('--nginx-snapshot', required=True, type=Path)
    adopt.add_argument('--compose-sha256', required=True)
    adopt.add_argument('--nginx-sha256', required=True)
    rollback = actions.add_parser('rollback', help='restore the release staged previously')
    rollback.add_argument('--version', required=True)
    rollback.add_argument('--bootstrap-previous-version')
    rollback.add_argument('--bootstrap-operation-state', type=Path)
    rollback.add_argument('--bootstrap-compose-snapshot', type=Path)
    rollback.add_argument('--bootstrap-nginx-snapshot', type=Path)
    rollback.add_argument('--bootstrap-compose-sha256')
    rollback.add_argument('--bootstrap-nginx-sha256')
    args = parser.parse_args()
    if args.action == 'protocol-version':
        print('2', flush=True)
    elif args.action == 'stage':
        deploy(args.archive, args.version, args.image_archive, args.retired_files)
    elif args.action == 'finalize':
        finalize_pending_release(args.version)
    elif args.action == 'adopt-legacy':
        adopt_legacy_pending_release(
            args.version,
            args.previous_version,
            args.operation_state,
            args.compose_snapshot,
            args.nginx_snapshot,
            args.compose_sha256,
            args.nginx_sha256,
        )
    else:
        rollback_pending_release(
            args.version,
            bootstrap_previous_version=args.bootstrap_previous_version,
            bootstrap_operation_state=args.bootstrap_operation_state,
            bootstrap_compose_snapshot=args.bootstrap_compose_snapshot,
            bootstrap_nginx_snapshot=args.bootstrap_nginx_snapshot,
            bootstrap_compose_sha256=args.bootstrap_compose_sha256,
            bootstrap_nginx_sha256=args.bootstrap_nginx_sha256,
        )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
