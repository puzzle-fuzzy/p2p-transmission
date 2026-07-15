#!/usr/bin/env python3
"""Atomically deploy a GitHub-built Rust 2.0 image on the production host."""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import tarfile
import time
import urllib.request
from pathlib import Path
from typing import Optional


APP_DIR = Path('/opt/p2p-transmission')
SOURCE_ARCHIVE_RE = re.compile(r'^p2p-transmission-[0-9a-f]{40}\.tar\.gz$')
IMAGE_ARCHIVE_RE = re.compile(r'^p2p-transmission-v2-[0-9a-f]{40}\.tar\.gz$')
VERSION_RE = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$')
ENV_KEY_RE = re.compile(r'^[A-Z][A-Z0-9_]*$')

V2_ENV = APP_DIR / 'deploy/v2/.env'
V2_DATA = APP_DIR / 'deploy/v2/data'
LEGACY_ENV = APP_DIR / 'deploy/.env'
NGINX_SOURCE = APP_DIR / 'deploy/v2/nginx/p2p.yxswy.com.conf'
NGINX_TARGET = Path('/etc/nginx/conf.d/p2p.yxswy.com.conf')
NGINX_PRE_V2_BACKUP = Path('/etc/nginx/conf.d/p2p.yxswy.com.conf.pre-rust-v2')
NGINX_ROLLBACK = Path('/tmp/p2p-transmission-nginx-rollback')

LEGACY_IMAGES = {
    'p2p-transmission-api:latest': 'p2p-transmission-api:pre-rust-v2',
    'p2p-transmission-web:latest': 'p2p-transmission-web:pre-rust-v2',
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


def compose_v2(*arguments: str) -> list[str]:
    return [
        'docker',
        'compose',
        '--env-file',
        'deploy/v2/.env',
        '-f',
        'deploy/v2/compose.yml',
        *arguments,
    ]


def compose_legacy(*arguments: str) -> list[str]:
    return ['docker', 'compose', '-f', 'deploy/compose.yml', *arguments]


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


def build_v2_env(
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


def prepare_v2_environment(version: str) -> Optional[bytes]:
    if not LEGACY_ENV.is_file():
        raise SystemExit('deploy/.env is missing on the host')
    legacy = parse_env_text(LEGACY_ENV.read_text(encoding='utf-8'))
    previous = V2_ENV.read_bytes() if V2_ENV.is_file() else None
    existing = parse_env_text(previous.decode('utf-8')) if previous is not None else {}
    try:
        rendered = format_env(build_v2_env(existing, legacy, version))
    except ValueError as error:
        raise SystemExit(str(error)) from error

    V2_ENV.parent.mkdir(parents=True, exist_ok=True)
    temporary = V2_ENV.with_name('.env.deploy.tmp')
    temporary.write_text(rendered, encoding='utf-8')
    os.chmod(temporary, 0o600)
    os.replace(temporary, V2_ENV)

    V2_DATA.mkdir(parents=True, exist_ok=True)
    os.chown(V2_DATA, 10001, 10001)
    os.chmod(V2_DATA, 0o700)
    return previous


def restore_v2_environment(previous: Optional[bytes]) -> None:
    if previous is None:
        V2_ENV.unlink(missing_ok=True)
        return
    temporary = V2_ENV.with_name('.env.rollback.tmp')
    temporary.write_bytes(previous)
    os.chmod(temporary, 0o600)
    os.replace(temporary, V2_ENV)


def preserve_rollback_assets(previous_tag: Optional[str]) -> None:
    for current, rollback in LEGACY_IMAGES.items():
        if image_exists(current) and not image_exists(rollback):
            run(['docker', 'image', 'tag', current, rollback])
    if previous_tag and image_exists(f'p2p-transmission-v2:{previous_tag}'):
        run([
            'docker',
            'image',
            'tag',
            f'p2p-transmission-v2:{previous_tag}',
            'p2p-transmission-v2:previous',
        ])
    if NGINX_TARGET.is_file() and not NGINX_PRE_V2_BACKUP.exists():
        shutil.copy2(NGINX_TARGET, NGINX_PRE_V2_BACKUP)


def snapshot_nginx() -> None:
    if not NGINX_TARGET.is_file():
        raise SystemExit('production Nginx configuration is missing')
    shutil.copy2(NGINX_TARGET, NGINX_ROLLBACK)


def install_v2_nginx() -> None:
    if not NGINX_SOURCE.is_file():
        raise SystemExit('Rust 2.0 Nginx configuration is missing')
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


def wait_for_v2_ready() -> None:
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
                print(f"Rust 2.0 ready: {payload['version']}", flush=True)
                return
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        time.sleep(2)
    run(compose_v2('ps'))
    run(compose_v2('logs', '--tail=200', 'app'))
    raise SystemExit('Rust 2.0 readiness check failed')


def rollback_runtime(previous_env: Optional[bytes], previous_tag: Optional[str]) -> None:
    best_effort(compose_v2('stop', 'app'))
    restore_nginx()
    restore_v2_environment(previous_env)
    if previous_tag and image_exists(f'p2p-transmission-v2:{previous_tag}'):
        best_effort(compose_v2('up', '-d', '--no-build', '--no-deps', 'app'))
    else:
        best_effort(compose_legacy('up', '-d', '--no-build', '--no-deps', 'api', 'web'))


def deploy_v2(image_archive: Path, version: str) -> None:
    previous_env_values = (
        parse_env_text(V2_ENV.read_text(encoding='utf-8')) if V2_ENV.is_file() else {}
    )
    previous_tag = previous_env_values.get('P2P_IMAGE_TAG')
    previous_env = prepare_v2_environment(version)
    preserve_rollback_assets(previous_tag)
    snapshot_nginx()

    expected_image = f'p2p-transmission-v2:{version}'
    try:
        run(['docker', 'load', '--input', str(image_archive)])
        if not image_exists(expected_image):
            raise SystemExit(f'image archive did not contain {expected_image}')
        run(compose_v2('config', '--quiet'))
        run(compose_v2('up', '-d', '--no-build', '--no-deps', 'app'))
        wait_for_v2_ready()
        install_v2_nginx()
        run(compose_legacy('stop', 'api', 'web'))
        NGINX_ROLLBACK.unlink(missing_ok=True)
        print(f'production now runs {expected_image}', flush=True)
    except BaseException:
        print('Rust 2.0 release failed; restoring the previous production runtime', flush=True)
        rollback_runtime(previous_env, previous_tag)
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
        deploy_v2(image, version)
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
