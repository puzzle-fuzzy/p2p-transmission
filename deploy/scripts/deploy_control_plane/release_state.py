"""Root-owned locks, rollback snapshots, and pending-release state."""

import base64
import binascii
import json
import os
import shutil
import stat
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Iterator, Optional

from .common import (
    APP_DIR,
    ARTIFACT_SNAPSHOT_PREFIX,
    COMPOSE_SNAPSHOT_PREFIX,
    CONTROL_PLANE_LOCK_NAME,
    IMAGE_ARCHIVE_RE,
    NGINX_SNAPSHOT_PREFIX,
    NGINX_TARGET,
    PENDING_RELEASE,
    PENDING_RELEASE_MAX_BYTES,
    PENDING_RELEASE_SCHEMA,
    PRODUCTION_BACKUPS,
    PRODUCTION_COMPOSE,
    PRODUCTION_ROLLBACK,
    SOURCE_ARCHIVE_RE,
    VERSION_RE,
    atomic_write_bytes,
    fsync_directory,
    parse_env_text,
    path_is_linklike,
)


def ensure_rollback_directory() -> Path:
    deploy_root = APP_DIR / 'deploy'
    production_root = deploy_root / 'production'
    expected_rollback = production_root / 'rollback'
    if PRODUCTION_ROLLBACK != expected_rollback:
        raise SystemExit('production rollback directory does not match the deployment layout')
    effective_uid = getattr(os, 'geteuid', lambda: 0)()
    for directory in (APP_DIR, deploy_root, production_root):
        if path_is_linklike(directory) or not directory.is_dir():
            raise SystemExit(f'production rollback ancestor is unsafe: {directory}')
        metadata = directory.stat()
        if os.name != 'nt' and (
            metadata.st_uid != effective_uid or stat.S_IMODE(metadata.st_mode) & 0o022
        ):
            raise SystemExit(
                f'production rollback ancestor ownership or mode is unsafe: {directory}'
            )
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
    metadata = rollback_root.stat()
    if os.name != 'nt' and (
        metadata.st_uid != effective_uid or stat.S_IMODE(metadata.st_mode) != 0o700
    ):
        raise SystemExit('production rollback directory ownership or mode is unsafe')
    return rollback_root

@contextmanager
def production_control_plane_lock() -> Iterator[None]:
    """Serialize every state-changing helper invocation on the production host."""

    rollback_root = ensure_rollback_directory()
    lock_path = rollback_root / CONTROL_PLANE_LOCK_NAME
    flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(lock_path, flags, 0o600)
    except OSError as error:
        raise SystemExit(f'cannot open the production control-plane lock: {error}') from error
    try:
        try:
            path_metadata = lock_path.lstat()
            opened_metadata = os.fstat(descriptor)
        except OSError as error:
            raise SystemExit(f'cannot inspect the production control-plane lock: {error}') from error
        effective_uid = getattr(os, 'geteuid', lambda: opened_metadata.st_uid)()
        if (
            stat.S_ISLNK(path_metadata.st_mode)
            or not stat.S_ISREG(path_metadata.st_mode)
            or not stat.S_ISREG(opened_metadata.st_mode)
            or path_metadata.st_dev != opened_metadata.st_dev
            or path_metadata.st_ino != opened_metadata.st_ino
            or opened_metadata.st_nlink != 1
            or (
                os.name != 'nt'
                and (
                    opened_metadata.st_uid != effective_uid
                    or stat.S_IMODE(opened_metadata.st_mode) != 0o600
                )
            )
        ):
            raise SystemExit('production control-plane lock ownership or mode is unsafe')
        if os.name != 'nt':
            import fcntl

            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise SystemExit('another production control-plane operation is active') from error
        yield
    finally:
        os.close(descriptor)

def cleanup_abandoned_release_artifacts() -> int:
    """Remove crash leftovers while the caller holds the control-plane lock."""

    rollback_root = ensure_rollback_directory()
    effective_uid = getattr(os, 'geteuid', lambda: 0)()
    patterns = (SOURCE_ARCHIVE_RE, IMAGE_ARCHIVE_RE)
    removed = 0
    try:
        candidates = tuple(rollback_root.iterdir())
    except OSError as error:
        raise SystemExit(f'cannot inspect private release artifacts: {error}') from error
    for candidate in candidates:
        if not candidate.name.startswith(ARTIFACT_SNAPSHOT_PREFIX):
            continue
        try:
            metadata = candidate.lstat()
        except OSError as error:
            raise SystemExit(f'cannot inspect private release artifact directory: {error}') from error
        if (
            candidate.name == ARTIFACT_SNAPSHOT_PREFIX
            or stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISDIR(metadata.st_mode)
            or (
                os.name != 'nt'
                and (
                    metadata.st_uid != effective_uid
                    or stat.S_IMODE(metadata.st_mode) != 0o700
                )
            )
        ):
            raise SystemExit(f'abandoned release artifact directory is unsafe: {candidate}')
        try:
            children = tuple(candidate.iterdir())
        except OSError as error:
            raise SystemExit(f'cannot inspect abandoned release artifacts: {error}') from error
        for child in children:
            try:
                child_metadata = child.lstat()
            except OSError as error:
                raise SystemExit(f'cannot inspect abandoned release artifact: {error}') from error
            if (
                not any(pattern.fullmatch(child.name) for pattern in patterns)
                or stat.S_ISLNK(child_metadata.st_mode)
                or not stat.S_ISREG(child_metadata.st_mode)
                or child_metadata.st_nlink != 1
                or (
                    os.name != 'nt'
                    and (
                        child_metadata.st_uid != effective_uid
                        or stat.S_IMODE(child_metadata.st_mode) != 0o600
                    )
                )
            ):
                raise SystemExit(f'abandoned release artifact is unsafe: {child}')
        for child in children:
            child.unlink()
        candidate.rmdir()
        removed += 1
    if removed:
        fsync_directory(rollback_root)
        print(f'abandoned private release artifact directories removed: {removed}', flush=True)
    return removed

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

def cleanup_snapshot_paths(*snapshots: Path) -> bool:
    cleaned = True
    changed_directories: set[Path] = set()
    for snapshot in snapshots:
        try:
            existed = snapshot.exists() or path_is_linklike(snapshot)
            snapshot.unlink(missing_ok=True)
            if existed:
                changed_directories.add(snapshot.parent)
        except OSError as error:
            print(f'rollback snapshot cleanup failed for {snapshot}: {error}', flush=True)
            cleaned = False
    for directory in changed_directories:
        try:
            fsync_directory(directory)
        except OSError as error:
            print(f'rollback snapshot directory sync failed for {directory}: {error}', flush=True)
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
        metadata = candidate.lstat()
    except OSError as error:
        raise SystemExit(f'pending release {label} snapshot is unavailable: {error}') from error
    effective_uid = getattr(os, 'geteuid', lambda: metadata.st_uid)()
    if (
        resolved.parent != rollback_root
        or not resolved.name.startswith(prefix)
        or path_is_linklike(candidate)
        or not resolved.is_file()
        or metadata.st_nlink != 1
        or (
            os.name != 'nt'
            and (
                metadata.st_uid != effective_uid
                or stat.S_IMODE(metadata.st_mode) != 0o600
            )
        )
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
        metadata = candidate.lstat()
    except OSError as error:
        raise SystemExit(f'pending release database backup is unavailable: {error}') from error
    effective_uid = getattr(os, 'geteuid', lambda: metadata.st_uid)()
    if (
        resolved.parent != backup_root
        or path_is_linklike(candidate)
        or not resolved.is_file()
        or metadata.st_nlink != 1
        or (
            os.name != 'nt'
            and (
                metadata.st_uid != effective_uid
                or stat.S_IMODE(metadata.st_mode) != 0o600
            )
        )
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

def load_pending_release(expected_version: str) -> ProductionPreflight:
    if not VERSION_RE.fullmatch(expected_version):
        raise SystemExit('release version contains unsupported characters')
    try:
        rollback_root = ensure_rollback_directory()
        resolved = PENDING_RELEASE.resolve(strict=True)
        metadata = PENDING_RELEASE.stat()
    except OSError as error:
        raise SystemExit(f'pending production release is unavailable: {error}') from error
    effective_uid = getattr(os, 'geteuid', lambda: metadata.st_uid)()
    if (
        resolved.parent != rollback_root
        or path_is_linklike(PENDING_RELEASE)
        or not resolved.is_file()
        or metadata.st_nlink != 1
        or (
            os.name != 'nt'
            and (
                metadata.st_uid != effective_uid
                or stat.S_IMODE(metadata.st_mode) != 0o600
            )
        )
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


def cleanup_abandoned_runtime_snapshots() -> int:
    """Remove unreferenced root-owned runtime snapshots after a crashed stage."""

    rollback_root = ensure_rollback_directory()
    referenced: set[Path] = set()
    if PENDING_RELEASE.exists() or path_is_linklike(PENDING_RELEASE):
        try:
            metadata = PENDING_RELEASE.lstat()
            effective_uid = getattr(os, 'geteuid', lambda: metadata.st_uid)()
            if (
                stat.S_ISLNK(metadata.st_mode)
                or not stat.S_ISREG(metadata.st_mode)
                or metadata.st_nlink != 1
                or metadata.st_size > PENDING_RELEASE_MAX_BYTES
                or (
                    os.name != 'nt'
                    and (
                        metadata.st_uid != effective_uid
                        or stat.S_IMODE(metadata.st_mode) != 0o600
                    )
                )
            ):
                raise SystemExit('pending production release state is missing or unsafe')
            payload = json.loads(PENDING_RELEASE.read_text(encoding='utf-8'))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SystemExit(f'cannot inspect pending production release: {error}') from error
        version = payload.get('release_version') if isinstance(payload, dict) else None
        if not isinstance(version, str) or not VERSION_RE.fullmatch(version):
            raise SystemExit('pending production release version is invalid')
        pending = load_pending_release(version)
        referenced = {pending.nginx_snapshot, pending.compose_snapshot}

    effective_uid = getattr(os, 'geteuid', lambda: 0)()
    prefixes = (NGINX_SNAPSHOT_PREFIX, COMPOSE_SNAPSHOT_PREFIX)
    removed = 0
    try:
        candidates = tuple(rollback_root.iterdir())
    except OSError as error:
        raise SystemExit(f'cannot inspect production rollback snapshots: {error}') from error
    for candidate in candidates:
        if not candidate.name.startswith(prefixes):
            continue
        try:
            metadata = candidate.lstat()
            resolved = candidate.resolve(strict=True)
        except OSError as error:
            raise SystemExit(f'cannot inspect production rollback snapshot: {error}') from error
        if (
            resolved.parent != rollback_root
            or stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or (
                os.name != 'nt'
                and (
                    metadata.st_uid != effective_uid
                    or stat.S_IMODE(metadata.st_mode) != 0o600
                )
            )
        ):
            raise SystemExit(f'production rollback snapshot is unsafe: {candidate}')
        if resolved in referenced:
            continue
        try:
            candidate.unlink()
        except OSError as error:
            raise SystemExit(f'cannot remove abandoned rollback snapshot: {error}') from error
        removed += 1
    if removed:
        fsync_directory(rollback_root)
        print(f'abandoned production rollback snapshots removed: {removed}', flush=True)
    return removed


def close_pending_release(preflight: ProductionPreflight) -> None:
    try:
        PENDING_RELEASE.unlink()
        fsync_directory(ensure_rollback_directory())
    except OSError as error:
        raise SystemExit(f'cannot clear pending production release state: {error}') from error
    if not preflight.cleanup_snapshots():
        raise SystemExit('pending production release closed but rollback snapshot cleanup failed')
