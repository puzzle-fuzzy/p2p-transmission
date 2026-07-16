#!/usr/bin/env python3
"""Atomically deploy a GitHub-built image on the production host."""

from __future__ import annotations

import argparse
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
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Optional


APP_DIR = Path('/opt/p2p-transmission')
SOURCE_ARCHIVE_RE = re.compile(r'^p2p-transmission-[0-9a-f]{40}\.tar\.gz$')
IMAGE_ARCHIVE_RE = re.compile(r'^p2p-transmission-image-[0-9a-f]{40}\.tar\.gz$')
RETIRED_FILES_RE = re.compile(r'^p2p-transmission-retired-[0-9a-f]{40}\.json$')
VERSION_RE = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')
ENV_KEY_RE = re.compile(r'^[A-Z][A-Z0-9_]*$')

PRODUCTION_ENV = APP_DIR / 'deploy/production/.env'
PRODUCTION_COMPOSE = APP_DIR / 'deploy/production/compose.yml'
PRODUCTION_DATA = APP_DIR / 'deploy/production/data'
PRODUCTION_DATABASE = PRODUCTION_DATA / 'control.sqlite3'
PRODUCTION_BACKUPS = APP_DIR / 'deploy/production/backups'
PRODUCTION_PROJECT = 'p2p-transmission-production'
DATABASE_BACKUP_LIMIT = 10
SOURCE_MANIFEST = APP_DIR / 'deploy/production/source-files.json'
NGINX_SOURCE = APP_DIR / 'deploy/production/nginx/p2p.yxswy.com.conf'
NGINX_TARGET = Path('/etc/nginx/conf.d/p2p.yxswy.com.conf')

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
        os.chmod(temporary, mode)
        os.replace(temporary, target)
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


def restore_production_database(backup: Optional[Path]) -> bool:
    if backup is None or not backup.is_file():
        return True
    try:
        copy_sqlite_database(backup, PRODUCTION_DATABASE, overwrite=True)
    except SystemExit as error:
        print(f'production database restore failed: {error}', flush=True)
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


def snapshot_runtime_file(source: Path, prefix: str) -> Path:
    if path_is_linklike(source) or not source.is_file():
        raise SystemExit(f'production rollback source is missing or unsafe: {source}')
    descriptor, name = tempfile.mkstemp(prefix=prefix, dir='/run')
    snapshot = Path(name)
    try:
        with source.open('rb') as source_file, os.fdopen(descriptor, 'wb') as destination:
            shutil.copyfileobj(source_file, destination)
        os.chmod(snapshot, 0o600)
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
    return snapshot_runtime_file(NGINX_TARGET, 'p2p-transmission-nginx-')


def snapshot_compose() -> Path:
    return snapshot_runtime_file(PRODUCTION_COMPOSE, 'p2p-transmission-compose-')


def backup_production_database(version: str) -> Optional[Path]:
    """Create and verify a consistent SQLite backup before changing the runtime."""
    if not PRODUCTION_DATABASE.is_file():
        print('production database is not present; backup is not required', flush=True)
        return None

    backup_root = PRODUCTION_BACKUPS.resolve()
    expected_parent = (APP_DIR / 'deploy/production').resolve()
    if backup_root.parent != expected_parent:
        raise SystemExit('database backup directory escapes the deployment directory')
    backup_root.mkdir(parents=True, exist_ok=True)
    os.chmod(backup_root, 0o700)

    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    destination = backup_root / f'control-{timestamp}-{version}.sqlite3'
    try:
        source_uri = f'{PRODUCTION_DATABASE.resolve().as_uri()}?mode=ro'
        with closing(sqlite3.connect(source_uri, uri=True, timeout=30.0)) as source:
            with closing(sqlite3.connect(destination, timeout=30.0)) as target:
                source.backup(target)
                result = target.execute('PRAGMA quick_check').fetchone()
                if result != ('ok',):
                    raise sqlite3.DatabaseError(f'backup quick_check failed: {result!r}')
        os.chmod(destination, 0o600)
    except (OSError, sqlite3.Error) as error:
        destination.unlink(missing_ok=True)
        raise SystemExit(f'production database backup failed: {error}') from error

    backups = sorted(backup_root.glob('control-*.sqlite3'), reverse=True)
    for old_backup in backups[DATABASE_BACKUP_LIMIT:]:
        if old_backup.resolve().parent != backup_root:
            raise SystemExit('database backup cleanup encountered an unsafe path')
        old_backup.unlink()

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


def readiness_matches(
    payload: object,
    expected_release: str,
    *,
    allow_unversioned: bool = False,
) -> bool:
    release = payload.get('release') if isinstance(payload, dict) else None
    exact_release = release == expected_release
    legacy_version = expected_release.rsplit('-', 1)[0]
    compatible_unversioned = (
        allow_unversioned and not release and payload.get('version') == legacy_version
        if isinstance(payload, dict)
        else False
    )
    return (
        isinstance(payload, dict)
        and payload.get('status') == 'ready'
        and payload.get('service') == 'p2p-server'
        and (exact_release or compatible_unversioned)
    )


def wait_for_readiness(expected_release: str, *, allow_unversioned: bool = False) -> bool:
    url = 'http://127.0.0.1:3410/health/ready'
    for _ in range(45):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                payload = json.loads(response.read().decode('utf-8'))
            if response.status == 200 and readiness_matches(
                payload,
                expected_release,
                allow_unversioned=allow_unversioned,
            ):
                actual = payload.get('release') or payload.get('version')
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

    def cleanup_snapshots(self) -> bool:
        return cleanup_snapshot_paths(self.nginx_snapshot, self.compose_snapshot)


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
    database_restored = False
    if environment_restored and compose_restored and nginx_restored:
        stopped = best_effort(compose_production('stop', 'app'))
        removed = stopped and best_effort(compose_production('rm', '--force', 'app'))
        database_restored = removed and restore_production_database(preflight.database_backup)

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
        ) and wait_for_readiness(preflight.previous_tag, allow_unversioned=True)

    if not prerequisites_restored or not runtime_restored:
        raise SystemExit('automatic production rollback failed; manual intervention is required')


def deploy_production(preflight: ProductionPreflight, version: str) -> None:
    try:
        prepare_production_environment(version, preflight.previous_env)
        run(compose_production('config', '--quiet'))
        run(compose_production('up', '-d', '--no-build', '--no-deps', 'app'))
        wait_for_production_ready(version)
        install_production_nginx()
        preflight.cleanup_snapshots()
        print(f'production now runs {preflight.expected_image}', flush=True)
    except BaseException as release_error:
        print('production release failed; restoring the previous production runtime', flush=True)
        try:
            rollback_runtime(preflight)
        except BaseException as rollback_error:
            preflight.cleanup_snapshots()
            raise SystemExit(f'production release and rollback failed: {rollback_error}') from release_error
        preflight.cleanup_snapshots()
        raise


def deploy(
    archive: Path,
    version: str,
    image_archive: Path,
    retired_files: Path,
) -> None:
    if not VERSION_RE.fullmatch(version):
        raise SystemExit('release version contains unsupported characters')
    archive = validate_source_archive(archive)
    image = validate_image_archive(image_archive)
    retired_path, bootstrap_files = validate_retired_files(retired_files)
    current_files = source_archive_files(archive)
    try:
        preflight = preflight_production(image, version)
        try:
            extract_archive(archive)
            remove_retired_source_files(current_files, bootstrap_files)
        except BaseException as source_error:
            compose_restored = restore_compose(preflight.compose_snapshot)
            preflight.cleanup_snapshots()
            if not compose_restored:
                raise SystemExit(
                    'source release failed and the previous Compose file could not be restored'
                ) from source_error
            raise
        deploy_production(preflight, version)
        write_source_manifest(current_files)
    finally:
        archive.unlink(missing_ok=True)
        image.unlink(missing_ok=True)
        retired_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--version', required=True)
    parser.add_argument('--image-archive', required=True, type=Path)
    parser.add_argument('--retired-files', required=True, type=Path)
    args = parser.parse_args()
    deploy(args.archive, args.version, args.image_archive, args.retired_files)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
