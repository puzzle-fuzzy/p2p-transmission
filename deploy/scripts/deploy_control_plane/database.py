"""SQLite backup, validation, restore, and recovery boundaries."""

import os
import secrets
import sqlite3
import tempfile
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .common import (
    APP_DIR,
    DATABASE_BACKUP_LIMIT,
    PRODUCTION_BACKUPS,
    PRODUCTION_DATA,
    PRODUCTION_DATABASE,
    fsync_directory,
    fsync_file,
    path_is_linklike,
)


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

def materialize_sqlite_snapshot(database: sqlite3.Connection) -> None:
    """Make an online backup self-contained before publishing its main file."""

    journal_mode = database.execute('PRAGMA journal_mode=DELETE').fetchone()
    if journal_mode != ('delete',):
        raise sqlite3.DatabaseError(
            f'failed to materialize SQLite snapshot journal mode: {journal_mode!r}'
        )
    result = database.execute('PRAGMA quick_check').fetchone()
    if result != ('ok',):
        raise sqlite3.DatabaseError(f'quick_check failed: {result!r}')

def remove_sqlite_sidecars(database: Path) -> None:
    for suffix in ('-wal', '-shm'):
        Path(f'{database}{suffix}').unlink(missing_ok=True)

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
                materialize_sqlite_snapshot(target_db)
        os.chmod(temporary, 0o600)
        set_data_owner(temporary)
        os.replace(temporary, destination)
    except (OSError, sqlite3.Error) as error:
        temporary.unlink(missing_ok=True)
        remove_sqlite_sidecars(temporary)
        raise SystemExit(f'SQLite copy failed from {source} to {destination}: {error}') from error

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
    descriptor: Optional[int] = None
    temporary: Optional[Path] = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f'.{destination.name}.backup-',
            suffix='.tmp',
            dir=backup_root,
        )
        temporary = Path(temporary_name)
        os.close(descriptor)
        descriptor = None
        source_uri = f'{PRODUCTION_DATABASE.resolve().as_uri()}?mode=ro'
        with closing(sqlite3.connect(source_uri, uri=True, timeout=30.0)) as source:
            with closing(sqlite3.connect(temporary, timeout=30.0)) as target:
                source.backup(target)
                materialize_sqlite_snapshot(target)
        os.chmod(temporary, 0o600)
        fsync_file(temporary)
        os.replace(temporary, destination)
        temporary = None
        fsync_directory(backup_root)
    except (OSError, sqlite3.Error) as error:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temporary is not None:
            temporary.unlink(missing_ok=True)
            remove_sqlite_sidecars(temporary)
        destination.unlink(missing_ok=True)
        raise SystemExit(f'production database backup failed: {error}') from error

    backups = sorted((*existing_backups, destination), reverse=True)
    for old_backup in backups[DATABASE_BACKUP_LIMIT:]:
        old_backup.unlink()
    fsync_directory(backup_root)

    print(f'production database backup ready: {destination}', flush=True)
    return destination

def latest_database_backup() -> Optional[Path]:
    backup_root = PRODUCTION_BACKUPS
    expected_root = APP_DIR / 'deploy/production/backups'
    if backup_root != expected_root or path_is_linklike(backup_root):
        raise SystemExit('database backup directory is unsafe')
    if not backup_root.exists():
        return None
    if not backup_root.is_dir():
        raise SystemExit('database backup directory is unsafe')
    backups = list(backup_root.glob('control-*.sqlite3'))
    if any(path_is_linklike(path) or not path.is_file() for path in backups):
        raise SystemExit('database backup directory contains an unsafe entry')
    return max(backups, key=lambda path: path.stat().st_mtime_ns, default=None)

def database_backup_age_seconds(backup: Path, *, now: Optional[float] = None) -> int:
    current_time = time.time() if now is None else now
    age = current_time - backup.stat().st_mtime
    if age < -300:
        raise SystemExit('database backup timestamp is unexpectedly in the future')
    return max(0, int(age))

def drill_database_restore(backup: Path) -> int:
    """Restore a backup into a disposable database and verify read/write integrity."""

    try:
        backup_root = PRODUCTION_BACKUPS.resolve(strict=True)
        resolved = backup.resolve(strict=True)
    except OSError as error:
        raise SystemExit(f'database restore drill input is unavailable: {error}') from error
    if (
        resolved.parent != backup_root
        or path_is_linklike(backup)
        or not resolved.is_file()
    ):
        raise SystemExit('database restore drill input is unsafe')

    try:
        with tempfile.TemporaryDirectory(prefix='.restore-drill-', dir=backup_root) as directory:
            restored = Path(directory) / 'control.sqlite3'
            copy_sqlite_database(resolved, restored)
            with closing(sqlite3.connect(restored, timeout=30.0)) as database:
                result = database.execute('PRAGMA quick_check').fetchone()
                if result != ('ok',):
                    raise sqlite3.DatabaseError(f'restore drill quick_check failed: {result!r}')
                user_version = int(database.execute('PRAGMA user_version').fetchone()[0])
                database.execute('BEGIN IMMEDIATE')
                database.execute(f'PRAGMA user_version = {(user_version + 1) % 2147483647}')
                database.rollback()
                restored_version = int(database.execute('PRAGMA user_version').fetchone()[0])
                if restored_version != user_version:
                    raise sqlite3.DatabaseError('restore drill rollback did not preserve metadata')
            verify_sqlite_database(restored)
            return restored.stat().st_size
    except (OSError, sqlite3.Error) as error:
        raise SystemExit(f'database restore drill failed: {error}') from error
