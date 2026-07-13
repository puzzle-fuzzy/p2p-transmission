#!/usr/bin/env python3
"""Safely deploy a GitHub Actions source archive on the Tencent Cloud host."""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
import subprocess
import tarfile
import time
import urllib.request
from pathlib import Path


APP_DIR = Path('/opt/p2p-transmission')
ARCHIVE_NAME_RE = re.compile(r'^p2p-transmission-[0-9a-f]{40}\.tar\.gz$')
VERSION_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._+\-]{0,127}$')
IMAGE_NAMES = ('p2p-transmission-api:latest', 'p2p-transmission-web:latest')


def run(command: list[str], *, cwd: Path = APP_DIR) -> subprocess.CompletedProcess[str]:
    print('$', ' '.join(command), flush=True)
    result = subprocess.run(command, cwd=cwd, text=True)
    if result.returncode != 0:
        raise SystemExit(result.returncode)
    return result


def compose(*arguments: str) -> list[str]:
    return ['docker', 'compose', '-f', 'deploy/compose.yml', *arguments]


def image_exists(image: str) -> bool:
    return subprocess.run(
        ['docker', 'image', 'inspect', image],
        capture_output=True,
    ).returncode == 0


def preserve_previous_images() -> bool:
    if not all(image_exists(image) for image in IMAGE_NAMES):
        return False
    for image in IMAGE_NAMES:
        run(['docker', 'image', 'tag', image, image.replace(':latest', ':previous')])
    return True


def restore_previous_images() -> None:
    for image in IMAGE_NAMES:
        previous = image.replace(':latest', ':previous')
        run(['docker', 'image', 'tag', previous, image])
    run(compose('up', '-d', '--no-build', '--no-deps', 'api', 'web'))


def validate_archive(archive: Path) -> None:
    resolved = archive.resolve()
    if resolved.parent != Path('/tmp') or not ARCHIVE_NAME_RE.fullmatch(resolved.name):
        raise SystemExit('archive must be a GitHub release archive under /tmp')
    if not resolved.is_file():
        raise SystemExit('release archive does not exist')

    with tarfile.open(resolved, 'r:gz') as tar:
        for member in tar.getmembers():
            if member.issym() or member.islnk():
                raise SystemExit('release archive must not contain symbolic links')
            target = (APP_DIR / member.name).resolve()
            if target != APP_DIR and APP_DIR not in target.parents:
                raise SystemExit(f'archive path escapes application directory: {member.name}')


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
    ], cwd=APP_DIR)


def set_build_version(version: str) -> None:
    if not VERSION_RE.fullmatch(version):
        raise SystemExit('build version contains unsupported characters')
    env_path = APP_DIR / 'deploy/.env'
    if not env_path.is_file():
        raise SystemExit('deploy/.env is missing on the host')

    lines = env_path.read_text(encoding='utf-8').splitlines()
    updated: list[str] = []
    found = False
    for line in lines:
        if line.startswith('VITE_APP_VERSION='):
            if not found:
                updated.append(f'VITE_APP_VERSION={version}')
                found = True
            continue
        updated.append(line)
    if not found:
        updated.append(f'VITE_APP_VERSION={version}')

    mode = stat.S_IMODE(env_path.stat().st_mode)
    temporary = env_path.with_name('.env.deploy.tmp')
    temporary.write_text('\n'.join(updated) + '\n', encoding='utf-8')
    os.chmod(temporary, mode)
    os.replace(temporary, env_path)


def check_http_health() -> bool:
    try:
        with urllib.request.urlopen('http://127.0.0.1:3333/health', timeout=3) as response:
            payload = json.loads(response.read().decode('utf-8'))
        with urllib.request.urlopen('http://127.0.0.1:8081/', timeout=3) as response:
            web_ok = response.status == 200
        return payload == {'ok': True} and web_ok
    except (OSError, ValueError, json.JSONDecodeError):
        return False


def wait_for_health() -> None:
    for _ in range(30):
        if check_http_health():
            print('release health: api and web are healthy')
            return
        time.sleep(2)
    run(compose('ps'))
    raise SystemExit('release health check failed')


def deploy(archive: Path, version: str) -> None:
    validate_archive(archive)
    previous_images = preserve_previous_images()
    try:
        extract_archive(archive)
        set_build_version(version)
        run(compose('config', '--quiet'))
        run(compose('build', 'api', 'web'))
        run(compose('up', '-d', '--no-deps', 'api', 'web'))
        wait_for_health()
    except BaseException:
        if previous_images:
            print('release failed; restoring previous api/web images', flush=True)
            restore_previous_images()
        raise
    finally:
        archive.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    deploy(args.archive, args.version)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
