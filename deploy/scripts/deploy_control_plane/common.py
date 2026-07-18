"""Shared constants and low-level primitives for the fixed deployment control plane."""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path, PurePosixPath
from typing import Optional

APP_DIR = Path('/opt/p2p-transmission')
UPLOAD_ROOT = Path('/tmp')
SOURCE_ARCHIVE_RE = re.compile(r'^p2p-transmission-[0-9a-f]{40}\.tar\.gz$')
IMAGE_ARCHIVE_RE = re.compile(r'^p2p-transmission-image-[0-9a-f]{40}\.tar\.gz$')
VERSION_RE = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')
ENV_KEY_RE = re.compile(r'^[A-Z][A-Z0-9_]*$')
SHA256_RE = re.compile(r'^[0-9a-f]{64}$')

PRODUCTION_ENV = APP_DIR / 'deploy/production/.env'
PRODUCTION_COMPOSE = APP_DIR / 'deploy/production/compose.yml'
PRODUCTION_DATA = APP_DIR / 'deploy/production/data'
PRODUCTION_DATABASE = PRODUCTION_DATA / 'control.sqlite3'
PRODUCTION_BACKUPS = APP_DIR / 'deploy/production/backups'
PRODUCTION_ROLLBACK = APP_DIR / 'deploy/production/rollback'
PRODUCTION_PROJECT = 'p2p-transmission-production'
DATABASE_BACKUP_LIMIT = 10
MAINTENANCE_BACKUP_MAX_AGE_SECONDS = 20 * 60 * 60
DISK_SAFETY_MARGIN_BYTES = 2 * 1024 * 1024 * 1024
SOURCE_MANIFEST = APP_DIR / 'deploy/production/source-files.json'
NGINX_SOURCE = APP_DIR / 'deploy/production/nginx/p2p.yxswy.com.conf'
NGINX_TARGET = Path('/etc/nginx/conf.d/p2p.yxswy.com.conf')
PENDING_RELEASE = PRODUCTION_ROLLBACK / 'pending.json'
PENDING_RELEASE_SCHEMA = 2
PENDING_RELEASE_MAX_BYTES = 64 * 1024
NGINX_SNAPSHOT_PREFIX = 'p2p-transmission-nginx-'
COMPOSE_SNAPSHOT_PREFIX = 'p2p-transmission-compose-'
INTERNAL_METRICS_URL = 'http://127.0.0.1:3410/internal/metrics'
REQUIRED_INTERNAL_METRICS = {
    'p2p_http_requests_total',
    'p2p_http_responses_5xx_total',
    'p2p_http_responses_429_total',
    'p2p_websocket_connections_active',
    'p2p_websocket_disconnects_total',
    'p2p_realtime_signal_rate_limited_total',
    'p2p_process_uptime_seconds',
}
CONTROL_PLANE_HELPER = Path(
    '/usr/local/libexec/p2p-transmission/current/deploy-release.py'
)
CONTROL_PLANE_LOCK_NAME = '.control-plane.lock'
ARTIFACT_SNAPSHOT_PREFIX = '.stage-artifacts-'
TRACKED_RUNTIME_CONFIG_HASHES = {
    'deploy/production/compose.yml': (
        '39317b5feafc35faba893e41d1570293990ef26770e81a6e561cd14277579696'
    ),
    'deploy/production/nginx/p2p.yxswy.com.conf': (
        '2f2cbe32cf30c684b8029742d26c914c211a8e4804a0f423de540f25f26cbc39'
    ),
}
MAX_RUNTIME_CONFIG_BYTES = 256 * 1024


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

def format_env(values: dict[str, str]) -> str:
    lines: list[str] = []
    for key, value in values.items():
        if not ENV_KEY_RE.fullmatch(key):
            raise ValueError(f'invalid environment key: {key!r}')
        if '\n' in value or '\r' in value:
            raise ValueError(f'environment value for {key} contains a newline')
        lines.append(f'{key}={value}')
    return '\n'.join(lines) + '\n'

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
