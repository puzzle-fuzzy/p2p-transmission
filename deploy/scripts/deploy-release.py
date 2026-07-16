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
import time
import urllib.request
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


APP_DIR = Path('/opt/p2p-transmission')
SOURCE_ARCHIVE_RE = re.compile(r'^p2p-transmission-[0-9a-f]{40}\.tar\.gz$')
IMAGE_ARCHIVE_RE = re.compile(r'^p2p-transmission-image-[0-9a-f]{40}\.tar\.gz$')
VERSION_RE = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')
ENV_KEY_RE = re.compile(r'^[A-Z][A-Z0-9_]*$')

PRODUCTION_ENV = APP_DIR / 'deploy/production/.env'
PRODUCTION_DATA = APP_DIR / 'deploy/production/data'
PRODUCTION_DATABASE = PRODUCTION_DATA / 'control.sqlite3'
PRODUCTION_BACKUPS = APP_DIR / 'deploy/production/backups'
PRODUCTION_PROJECT = 'p2p-transmission-production'
DATABASE_BACKUP_LIMIT = 10
LEGACY_ENV = APP_DIR / 'deploy/.env'
NGINX_SOURCE = APP_DIR / 'deploy/production/nginx/p2p.yxswy.com.conf'
NGINX_TARGET = Path('/etc/nginx/conf.d/p2p.yxswy.com.conf')
NGINX_PREVIOUS_BACKUP = Path('/etc/nginx/conf.d/p2p.yxswy.com.conf.previous')
NGINX_ROLLBACK = Path('/tmp/p2p-transmission-nginx-rollback')

LEGACY_IMAGES = {
    'p2p-transmission-api:latest': 'p2p-transmission-api:pre-release',
    'p2p-transmission-web:latest': 'p2p-transmission-web:pre-release',
}


def run(command: list[str], *, cwd: Path = APP_DIR) -> subprocess.CompletedProcess[str]:
    print('$', ' '.join(command), flush=True)
    result = subprocess.run(command, cwd=cwd, text=True)
    if result.returncode != 0:
        raise SystemExit(result.returncode)
    return result


def best_effort(command: list[str], *, cwd: Path = APP_DIR) -> bool:
    print('$', ' '.join(command), '(rollback)', flush=True)
    return subprocess.run(command, cwd=cwd, text=True).returncode == 0


def compose_production(*arguments: str) -> list[str]:
    return [
        'docker',
        'compose',
        '--project-name',
        PRODUCTION_PROJECT,
        '--env-file',
        'deploy/production/.env',
        '-f',
        'deploy/production/compose.yml',
        *arguments,
    ]


def compose_legacy(*arguments: str) -> list[str]:
    return ['docker', 'compose', '-f', 'deploy/compose.yml', *arguments]


def relative_app_path(path: Path) -> str:
    return str(path.resolve().relative_to(APP_DIR.resolve()))


def find_legacy_production_root() -> Optional[Path]:
    """Find the previous Rust deployment left on the host during migration.

    The old directory is discovered from its Compose shape instead of being
    part of the current project naming. This keeps the compatibility path
    isolated while still allowing a one-time in-place migration.
    """

    deploy_root = APP_DIR / 'deploy'
    if not deploy_root.is_dir():
        return None

    for candidate in sorted(deploy_root.iterdir()):
        if not candidate.is_dir() or candidate.name == 'production':
            continue
        compose_file = candidate / 'compose.yml'
        if not compose_file.is_file():
            continue
        try:
            compose_text = compose_file.read_text(encoding='utf-8')
        except OSError:
            continue
        if 'P2P_DATABASE_PATH' in compose_text and ':3410' in compose_text:
            return candidate
    return None


def legacy_production_project(root: Path) -> str:
    compose_file = root / 'compose.yml'
    compose_text = compose_file.read_text(encoding='utf-8')
    match = re.search(r'^name:\s*([A-Za-z0-9][A-Za-z0-9_.-]*)\s*$', compose_text, re.MULTILINE)
    return match.group(1) if match else root.name


def compose_legacy_production(root: Path, *arguments: str) -> list[str]:
    command = [
        'docker',
        'compose',
        '--project-name',
        legacy_production_project(root),
    ]
    env_file = root / '.env'
    if env_file.is_file():
        command.extend(['--env-file', relative_app_path(env_file)])
    command.extend(['-f', relative_app_path(root / 'compose.yml'), *arguments])
    return command


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


def validate_source_archive(archive: Path) -> Path:
    resolved = validate_tmp_file(archive, SOURCE_ARCHIVE_RE, 'source archive')
    with tarfile.open(resolved, 'r:gz') as tar:
        for member in tar.getmembers():
            if member.issym() or member.islnk():
                raise SystemExit('source archive must not contain symbolic links')
            target = (APP_DIR / member.name).resolve()
            if target != APP_DIR and APP_DIR not in target.parents:
                raise SystemExit(f'archive path escapes application directory: {member.name}')
    return resolved


def validate_image_archive(archive: Path) -> Path:
    return validate_tmp_file(archive, IMAGE_ARCHIVE_RE, 'image archive')


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
    temporary = destination.with_name(f'.{destination.name}.migration.tmp')
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
        raise SystemExit(f'SQLite migration failed from {source} to {destination}: {error}') from error


def migrate_legacy_database(root: Path) -> bool:
    source = root / 'data/control.sqlite3'
    if PRODUCTION_DATABASE.exists():
        return False
    if not source.exists():
        return False
    copy_sqlite_database(source, PRODUCTION_DATABASE)
    print(f'production database migrated from {source}', flush=True)
    return True


def migrate_legacy_backups(root: Path) -> int:
    source_root = root / 'backups'
    if not source_root.is_dir():
        return 0
    if PRODUCTION_BACKUPS.exists() and any(PRODUCTION_BACKUPS.iterdir()):
        return 0

    sources = sorted(source_root.glob('control-*.sqlite3'), reverse=True)
    if not sources:
        return 0

    PRODUCTION_BACKUPS.mkdir(parents=True, exist_ok=True)
    os.chmod(PRODUCTION_BACKUPS, 0o700)
    migrated = 0
    for source in sources[:DATABASE_BACKUP_LIMIT]:
        if source.is_symlink() or not source.is_file() or source.resolve().parent != source_root.resolve():
            raise SystemExit(f'unsafe legacy database backup: {source}')
        destination = PRODUCTION_BACKUPS / source.name
        temporary = destination.with_name(f'.{destination.name}.migration.tmp')
        shutil.copy2(source, temporary)
        try:
            verify_sqlite_database(temporary)
            os.chmod(temporary, 0o600)
            os.replace(temporary, destination)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
        migrated += 1

    print(f'migrated {migrated} verified production database backups', flush=True)
    return migrated


def migrate_legacy_production_state(root: Optional[Path]) -> None:
    if root is None:
        return
    migrate_legacy_database(root)
    migrate_legacy_backups(root)


def build_production_env(
    existing: dict[str, str],
    legacy: dict[str, str],
    version: str,
    *,
    capability_secret: Optional[str] = None,
) -> dict[str, str]:
    if not VERSION_RE.fullmatch(version):
        raise ValueError('release version is not a valid Docker tag')

    turn_urls = existing.get('P2P_TURN_URLS') or legacy.get('TURN_URLS', '')
    turn_secret = existing.get('P2P_TURN_SECRET') or legacy.get('TURN_SHARED_SECRET', '')
    generated_capability = capability_secret or secrets.token_urlsafe(48)
    capability = existing.get('P2P_CAPABILITY_SECRET') or generated_capability
    ice_urls = (
        existing.get('P2P_ICE_URLS')
        or legacy.get('VITE_STUN_URLS')
        or 'stun:stun.l.google.com:19302'
    )

    if not turn_urls:
        raise ValueError('legacy TURN_URLS is missing')
    if len(turn_secret) < 16:
        raise ValueError('legacy TURN_SHARED_SECRET is missing or too short')
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


def prepare_production_environment(version: str) -> Optional[bytes]:
    previous = PRODUCTION_ENV.read_bytes() if PRODUCTION_ENV.is_file() else None
    existing = parse_env_text(previous.decode('utf-8')) if previous is not None else {}
    legacy = parse_env_text(LEGACY_ENV.read_text(encoding='utf-8')) if LEGACY_ENV.is_file() else {}

    legacy_root = find_legacy_production_root()
    if legacy_root is not None:
        legacy_rust_env = legacy_root / '.env'
        if legacy_rust_env.is_file():
            for key, value in parse_env_text(legacy_rust_env.read_text(encoding='utf-8')).items():
                if key.startswith('P2P_'):
                    existing.setdefault(key, value)

    if not existing and not legacy:
        raise SystemExit('production environment is missing on the host')

    try:
        rendered = format_env(build_production_env(existing, legacy, version))
    except ValueError as error:
        raise SystemExit(str(error)) from error

    PRODUCTION_ENV.parent.mkdir(parents=True, exist_ok=True)
    temporary = PRODUCTION_ENV.with_name('.env.deploy.tmp')
    temporary.write_text(rendered, encoding='utf-8')
    os.chmod(temporary, 0o600)
    os.replace(temporary, PRODUCTION_ENV)

    PRODUCTION_DATA.mkdir(parents=True, exist_ok=True)
    set_data_owner(PRODUCTION_DATA)
    os.chmod(PRODUCTION_DATA, 0o700)
    return previous


def restore_production_environment(previous: Optional[bytes]) -> None:
    if previous is None:
        PRODUCTION_ENV.unlink(missing_ok=True)
        return
    temporary = PRODUCTION_ENV.with_name('.env.rollback.tmp')
    temporary.write_bytes(previous)
    os.chmod(temporary, 0o600)
    os.replace(temporary, PRODUCTION_ENV)


def docker_container_ids(project: str, *, running_only: bool) -> list[str]:
    command = ['docker', 'ps']
    if not running_only:
        command.append('-a')
    command.extend([
        '-q',
        '--filter',
        f'label=com.docker.compose.project={project}',
        '--filter',
        'label=com.docker.compose.service=app',
    ])
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        return []
    return [container_id for container_id in result.stdout.splitlines() if container_id]


def stop_legacy_production_runtime(root: Path) -> None:
    project = legacy_production_project(root)
    containers = docker_container_ids(project, running_only=True)
    if containers:
        run(['docker', 'stop', *containers])
        print(f'stopped legacy production runtime {project}', flush=True)


def restore_legacy_production_runtime(root: Optional[Path]) -> bool:
    if root is None:
        return False
    project = legacy_production_project(root)
    containers = docker_container_ids(project, running_only=False)
    if containers:
        return best_effort(['docker', 'start', *containers])
    return best_effort(compose_legacy_production(root, 'up', '-d', '--no-build', '--no-deps', 'app'))


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


def preserve_rollback_assets(previous_tag: Optional[str]) -> None:
    for current, rollback in LEGACY_IMAGES.items():
        if image_exists(current) and not image_exists(rollback):
            run(['docker', 'image', 'tag', current, rollback])
    if previous_tag and image_exists(f'p2p-transmission:{previous_tag}'):
        run([
            'docker',
            'image',
            'tag',
            f'p2p-transmission:{previous_tag}',
            'p2p-transmission:previous',
        ])
    if NGINX_TARGET.is_file() and not NGINX_PREVIOUS_BACKUP.exists():
        shutil.copy2(NGINX_TARGET, NGINX_PREVIOUS_BACKUP)


def snapshot_nginx() -> None:
    if not NGINX_TARGET.is_file():
        raise SystemExit('production Nginx configuration is missing')
    shutil.copy2(NGINX_TARGET, NGINX_ROLLBACK)


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
    if not NGINX_SOURCE.is_file():
        raise SystemExit('production Nginx configuration is missing')
    temporary = NGINX_TARGET.with_name('p2p.yxswy.com.conf.deploy-tmp')
    shutil.copy2(NGINX_SOURCE, temporary)
    os.chmod(temporary, 0o644)
    os.replace(temporary, NGINX_TARGET)
    run(['nginx', '-t'])
    run(['systemctl', 'reload', 'nginx'])


def restore_nginx() -> None:
    if not NGINX_ROLLBACK.is_file():
        return
    shutil.copy2(NGINX_ROLLBACK, NGINX_TARGET)
    os.chmod(NGINX_TARGET, 0o644)
    if best_effort(['nginx', '-t']):
        best_effort(['systemctl', 'reload', 'nginx'])


def wait_for_production_ready() -> None:
    url = 'http://127.0.0.1:3410/health/ready'
    for _ in range(45):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                payload = json.loads(response.read().decode('utf-8'))
            if (
                response.status == 200
                and payload.get('status') == 'ready'
                and payload.get('service') == 'p2p-server'
                and payload.get('version')
            ):
                print(f"production ready: {payload['version']}", flush=True)
                return
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        time.sleep(2)
    run(compose_production('ps'))
    run(compose_production('logs', '--tail=200', 'app'))
    raise SystemExit('production readiness check failed')


def rollback_runtime(
    previous_env: Optional[bytes],
    previous_tag: Optional[str],
    database_backup: Optional[Path],
    legacy_root: Optional[Path],
) -> None:
    best_effort(compose_production('stop', 'app'))
    best_effort(compose_production('rm', '--force', 'app'))
    restore_production_database(database_backup)
    restore_nginx()
    restore_production_environment(previous_env)
    if previous_tag and image_exists(f'p2p-transmission:{previous_tag}'):
        best_effort(compose_production('up', '-d', '--no-build', '--no-deps', 'app'))
    elif restore_legacy_production_runtime(legacy_root):
        return
    else:
        best_effort(compose_legacy('up', '-d', '--no-build', '--no-deps', 'api', 'web'))


def deploy_production(image_archive: Path, version: str) -> None:
    previous_env_values = (
        parse_env_text(PRODUCTION_ENV.read_text(encoding='utf-8')) if PRODUCTION_ENV.is_file() else {}
    )
    previous_tag = previous_env_values.get('P2P_IMAGE_TAG')
    legacy_root = find_legacy_production_root()
    previous_env: Optional[bytes] = None
    database_backup: Optional[Path] = None
    expected_image = f'p2p-transmission:{version}'
    try:
        migrate_legacy_production_state(legacy_root)
        previous_env = prepare_production_environment(version)
        preserve_rollback_assets(previous_tag)
        snapshot_nginx()
        database_backup = backup_production_database(version)
        run(['docker', 'load', '--input', str(image_archive)])
        if not image_exists(expected_image):
            raise SystemExit(f'image archive did not contain {expected_image}')
        run(compose_production('config', '--quiet'))
        if legacy_root is not None:
            stop_legacy_production_runtime(legacy_root)
        run(compose_production('up', '-d', '--no-build', '--no-deps', 'app'))
        wait_for_production_ready()
        install_production_nginx()
        run(compose_legacy('stop', 'api', 'web'))
        NGINX_ROLLBACK.unlink(missing_ok=True)
        print(f'production now runs {expected_image}', flush=True)
    except BaseException:
        print('production release failed; restoring the previous production runtime', flush=True)
        rollback_runtime(previous_env, previous_tag, database_backup, legacy_root)
        raise


def deploy(archive: Path, version: str, image_archive: Optional[Path]) -> None:
    if not VERSION_RE.fullmatch(version):
        raise SystemExit('release version contains unsupported characters')
    archive = validate_source_archive(archive)
    image = validate_image_archive(image_archive) if image_archive is not None else None
    try:
        extract_archive(archive)
        if image is None:
            print('deployment source updated; runtime was not changed', flush=True)
            return
        deploy_production(image, version)
    finally:
        archive.unlink(missing_ok=True)
        if image is not None:
            image.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--version', required=True)
    parser.add_argument('--image-archive', type=Path)
    args = parser.parse_args()
    deploy(args.archive, args.version, args.image_archive)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
