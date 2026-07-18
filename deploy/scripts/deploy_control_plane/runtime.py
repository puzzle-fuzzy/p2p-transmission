"""Docker, Nginx, health, maintenance, and runtime transition operations."""

import json
import os
import secrets
import time
import urllib.request
from pathlib import Path
from typing import Optional

from .common import (
    INTERNAL_METRICS_URL,
    MAINTENANCE_BACKUP_MAX_AGE_SECONDS,
    NGINX_SOURCE,
    NGINX_TARGET,
    PENDING_RELEASE,
    PRODUCTION_COMPOSE,
    PRODUCTION_DATA,
    PRODUCTION_DATABASE,
    PRODUCTION_ENV,
    REQUIRED_INTERNAL_METRICS,
    VERSION_RE,
    atomic_write_bytes,
    best_effort,
    compose_production,
    format_env,
    image_exists,
    image_id,
    parse_env_text,
    path_is_linklike,
    run,
    running_production_image_id,
)
from .capacity import maintenance_disk_demands, require_disk_capacity
from .database import (
    backup_production_database,
    database_backup_age_seconds,
    drill_database_restore,
    latest_database_backup,
    restore_production_database,
    set_data_owner,
    validate_production_database_restore_target,
    verify_sqlite_database,
)
from .docker_archive import load_verified_docker_image_archive
from .release_state import (
    ProductionPreflight,
    cleanup_snapshot_paths,
    close_pending_release,
    load_pending_release,
    mark_pending_database_may_have_changed,
    mark_pending_rollback_database_restored,
    restore_runtime_file,
    snapshot_compose,
    snapshot_nginx,
    write_pending_release,
)


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

def require_rollback_image(previous_tag: Optional[str]) -> str:
    if not previous_tag or not VERSION_RE.fullmatch(previous_tag):
        raise SystemExit('previous production image tag is missing or invalid')
    image = f'p2p-transmission:{previous_tag}'
    if not image_exists(image):
        raise SystemExit(f'previous production image is unavailable: {image}')
    return image

def preserve_rollback_image(image: str) -> None:
    run(['docker', 'image', 'tag', image, 'p2p-transmission:previous'])


def maintain_production() -> dict[str, object]:
    """Check the live runtime, refresh an aged backup, and prove it can be restored."""

    if PENDING_RELEASE.exists() or path_is_linklike(PENDING_RELEASE):
        raise SystemExit('production maintenance refuses to run while a release is pending')
    if validate_production_database_restore_target() is None:
        raise SystemExit('production database layout is unsafe for maintenance')
    if not PRODUCTION_DATA.is_dir() or path_is_linklike(PRODUCTION_DATA):
        raise SystemExit('production data directory is missing or unsafe')

    release = current_production_release()
    if release is None or not production_runtime_matches(release):
        raise SystemExit('production runtime identity or readiness check failed')
    metrics = fetch_internal_metrics()
    if path_is_linklike(PRODUCTION_DATABASE) or not PRODUCTION_DATABASE.is_file():
        raise SystemExit('production database is missing or unsafe')
    verify_sqlite_database(PRODUCTION_DATABASE)

    backup = latest_database_backup()
    created = backup is None
    if backup is not None:
        created = database_backup_age_seconds(backup) >= MAINTENANCE_BACKUP_MAX_AGE_SECONDS
    disk_capacities = require_disk_capacity(
        maintenance_disk_demands(backup, create_backup=created)
    )
    if created:
        backup = backup_production_database(release)
    if backup is None:
        raise SystemExit('production database backup was not created')

    verify_sqlite_database(backup)
    restored_bytes = drill_database_restore(backup)
    result: dict[str, object] = {
        'status': 'healthy',
        'release': release,
        'disk_free_bytes': min(capacity.free_bytes for capacity in disk_capacities),
        'disk_required_bytes': max(
            capacity.required_bytes for capacity in disk_capacities
        ),
        'backup': backup.name,
        'backup_age_seconds': database_backup_age_seconds(backup),
        'backup_created': created,
        'restore_drill_bytes': restored_bytes,
        'metrics': metrics,
    }
    print(json.dumps(result, sort_keys=True), flush=True)
    return result

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

def parse_internal_metrics(payload: str) -> dict[str, int]:
    metrics: dict[str, int] = {}
    for line in payload.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split()
        if len(parts) != 2 or parts[0] not in REQUIRED_INTERNAL_METRICS:
            continue
        name, raw_value = parts
        if name in metrics or not raw_value.isascii() or not raw_value.isdecimal():
            raise SystemExit(f'internal metric is invalid or duplicated: {name}')
        metrics[name] = int(raw_value)
    missing = REQUIRED_INTERNAL_METRICS - metrics.keys()
    if missing:
        raise SystemExit(f'internal metrics are missing: {sorted(missing)}')
    return metrics

def fetch_internal_metrics() -> dict[str, int]:
    try:
        with urllib.request.urlopen(INTERNAL_METRICS_URL, timeout=3) as response:
            body = response.read(64 * 1024 + 1)
            status = response.status
    except OSError as error:
        raise SystemExit(f'internal metrics request failed: {error}') from error
    if status != 200 or len(body) > 64 * 1024:
        raise SystemExit('internal metrics response is invalid')
    try:
        payload = body.decode('utf-8')
    except UnicodeDecodeError as error:
        raise SystemExit('internal metrics response is not UTF-8') from error
    return parse_internal_metrics(payload)

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

def finalize_pending_release(version: str) -> None:
    preflight = load_pending_release(version)
    wait_for_production_ready(version)
    close_pending_release(preflight)
    print(f'production release finalized: {preflight.expected_image}', flush=True)

def rollback_pending_release(version: str) -> None:
    if not PENDING_RELEASE.exists():
        if path_is_linklike(PENDING_RELEASE):
            raise SystemExit('pending production release state is missing or unsafe')
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
        load_verified_docker_image_archive(image_archive, expected_image)
    except BaseException as preflight_error:
        cleaned = cleanup_snapshot_paths(
            *(snapshot for snapshot in (nginx_snapshot, compose_snapshot) if snapshot is not None)
        )
        if not cleaned:
            raise SystemExit(
                'production preflight failed and rollback snapshot cleanup was incomplete'
            ) from preflight_error
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
                if not preflight.cleanup_snapshots():
                    raise SystemExit(
                        'production rollback snapshot cleanup was incomplete'
                    )
        except BaseException as rollback_error:
            raise SystemExit(f'production release and rollback failed: {rollback_error}') from release_error
        raise
