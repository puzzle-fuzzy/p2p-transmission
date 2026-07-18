from __future__ import annotations

import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from deploy_control_plane import common
from deploy_control_plane import database as database_ops


class ControlPlaneDatabaseTests(unittest.TestCase):
    def test_rollback_removes_database_created_by_the_staged_release(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            production_data = root / 'deploy/production/data'
            production_database = production_data / 'control.sqlite3'
            production_data.mkdir(parents=True)
            production_database.write_bytes(b'target release state')
            Path(f'{production_database}-wal').write_bytes(b'target wal state')
            Path(f'{production_database}-shm').write_bytes(b'target shm state')
            original_values = (
                database_ops.APP_DIR,
                database_ops.PRODUCTION_DATA,
                database_ops.PRODUCTION_DATABASE,
            )
            database_ops.APP_DIR = root
            database_ops.PRODUCTION_DATA = production_data
            database_ops.PRODUCTION_DATABASE = production_database
            try:
                with patch.object(database_ops, 'fsync_directory') as synced:
                    self.assertTrue(database_ops.restore_production_database(None))
                synced.assert_called_once_with(production_data)
                self.assertFalse(production_database.exists())
                self.assertFalse(Path(f'{production_database}-wal').exists())
                self.assertFalse(Path(f'{production_database}-shm').exists())
            finally:
                (
                    database_ops.APP_DIR,
                    database_ops.PRODUCTION_DATA,
                    database_ops.PRODUCTION_DATABASE,
                ) = original_values

    def test_rollback_removes_wal_sidecars_before_restoring_backup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            production_data = root / 'deploy/production/data'
            production_database = production_data / 'control.sqlite3'
            backup = root / 'backup.sqlite3'
            production_data.mkdir(parents=True)
            with closing(sqlite3.connect(production_database)) as database:
                database.execute('CREATE TABLE target_state (value TEXT)')
            with closing(sqlite3.connect(backup)) as database:
                database.execute('CREATE TABLE previous_state (value TEXT)')
            Path(f'{production_database}-wal').write_bytes(b'stale target wal')
            Path(f'{production_database}-shm').write_bytes(b'stale target shm')
            original_values = (
                database_ops.APP_DIR,
                database_ops.PRODUCTION_DATA,
                database_ops.PRODUCTION_DATABASE,
            )
            database_ops.APP_DIR = root
            database_ops.PRODUCTION_DATA = production_data
            database_ops.PRODUCTION_DATABASE = production_database
            try:
                self.assertTrue(database_ops.restore_production_database(backup))
                self.assertFalse(Path(f'{production_database}-wal').exists())
                self.assertFalse(Path(f'{production_database}-shm').exists())
                with closing(sqlite3.connect(production_database)) as database:
                    tables = {
                        row[0]
                        for row in database.execute(
                            "SELECT name FROM sqlite_master WHERE type = 'table'"
                        )
                    }
                self.assertIn('previous_state', tables)
                self.assertNotIn('target_state', tables)
            finally:
                (
                    database_ops.APP_DIR,
                    database_ops.PRODUCTION_DATA,
                    database_ops.PRODUCTION_DATABASE,
                ) = original_values

    def test_invalid_backup_preserves_current_database_and_wal_sidecars(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            production_data = root / 'deploy/production/data'
            production_database = production_data / 'control.sqlite3'
            backup = root / 'invalid-backup.sqlite3'
            production_data.mkdir(parents=True)
            production_database.write_bytes(b'current database')
            wal = Path(f'{production_database}-wal')
            shm = Path(f'{production_database}-shm')
            wal.write_bytes(b'current wal')
            shm.write_bytes(b'current shm')
            backup.write_bytes(b'not sqlite')
            original_values = (
                database_ops.APP_DIR,
                database_ops.PRODUCTION_DATA,
                database_ops.PRODUCTION_DATABASE,
            )
            database_ops.APP_DIR = root
            database_ops.PRODUCTION_DATA = production_data
            database_ops.PRODUCTION_DATABASE = production_database
            try:
                self.assertFalse(database_ops.restore_production_database(backup))
                self.assertEqual(production_database.read_bytes(), b'current database')
                self.assertEqual(wal.read_bytes(), b'current wal')
                self.assertEqual(shm.read_bytes(), b'current shm')
            finally:
                (
                    database_ops.APP_DIR,
                    database_ops.PRODUCTION_DATA,
                    database_ops.PRODUCTION_DATABASE,
                ) = original_values

    def test_rollback_refuses_nonregular_database_sidecar(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            production_data = root / 'deploy/production/data'
            production_database = production_data / 'control.sqlite3'
            production_data.mkdir(parents=True)
            production_database.write_bytes(b'must remain')
            Path(f'{production_database}-wal').mkdir()
            original_values = (
                database_ops.APP_DIR,
                database_ops.PRODUCTION_DATA,
                database_ops.PRODUCTION_DATABASE,
            )
            database_ops.APP_DIR = root
            database_ops.PRODUCTION_DATA = production_data
            database_ops.PRODUCTION_DATABASE = production_database
            try:
                self.assertFalse(database_ops.restore_production_database(None))
                self.assertTrue(production_database.exists())
            finally:
                (
                    database_ops.APP_DIR,
                    database_ops.PRODUCTION_DATA,
                    database_ops.PRODUCTION_DATABASE,
                ) = original_values

    def test_rollback_refuses_to_remove_database_through_unsafe_data_path(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            production_root = root / 'deploy/production'
            outside = root / 'outside'
            production_root.mkdir(parents=True)
            outside.mkdir()
            data_link = production_root / 'data'
            try:
                data_link.symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest('directory symlinks are unavailable on this platform')
            production_database = data_link / 'control.sqlite3'
            production_database.write_bytes(b'must remain')
            original_values = (
                database_ops.APP_DIR,
                database_ops.PRODUCTION_DATA,
                database_ops.PRODUCTION_DATABASE,
            )
            database_ops.APP_DIR = root
            database_ops.PRODUCTION_DATA = data_link
            database_ops.PRODUCTION_DATABASE = production_database
            try:
                self.assertFalse(database_ops.restore_production_database(None))
                self.assertTrue((outside / 'control.sqlite3').exists())
            finally:
                (
                    database_ops.APP_DIR,
                    database_ops.PRODUCTION_DATA,
                    database_ops.PRODUCTION_DATABASE,
                ) = original_values

    def test_rollback_refuses_symlinked_production_ancestor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            deploy_root = root / 'deploy'
            outside_production = root / 'outside-production'
            outside_data = outside_production / 'data'
            deploy_root.mkdir()
            outside_data.mkdir(parents=True)
            production_link = deploy_root / 'production'
            try:
                production_link.symlink_to(outside_production, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest('directory symlinks are unavailable on this platform')
            production_data = production_link / 'data'
            production_database = production_data / 'control.sqlite3'
            production_database.write_bytes(b'must remain outside')
            original_values = (
                database_ops.APP_DIR,
                database_ops.PRODUCTION_DATA,
                database_ops.PRODUCTION_DATABASE,
            )
            database_ops.APP_DIR = root
            database_ops.PRODUCTION_DATA = production_data
            database_ops.PRODUCTION_DATABASE = production_database
            try:
                self.assertFalse(database_ops.restore_production_database(None))
                self.assertEqual(
                    (outside_data / 'control.sqlite3').read_bytes(),
                    b'must remain outside',
                )
            finally:
                (
                    database_ops.APP_DIR,
                    database_ops.PRODUCTION_DATA,
                    database_ops.PRODUCTION_DATABASE,
                ) = original_values

    def test_creates_verified_database_backup_and_prunes_old_copies(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original_values = (
                database_ops.APP_DIR,
                database_ops.PRODUCTION_DATA,
                database_ops.PRODUCTION_DATABASE,
                database_ops.PRODUCTION_BACKUPS,
            )
            database_ops.APP_DIR = root
            database_ops.PRODUCTION_DATA = root / 'deploy/production/data'
            database_ops.PRODUCTION_DATABASE = root / 'deploy/production/data/control.sqlite3'
            database_ops.PRODUCTION_BACKUPS = root / 'deploy/production/backups'
            try:
                database_ops.PRODUCTION_DATABASE.parent.mkdir(parents=True)
                with closing(sqlite3.connect(database_ops.PRODUCTION_DATABASE)) as database:
                    database.execute('CREATE TABLE rooms (code TEXT PRIMARY KEY)')
                    database.execute('INSERT INTO rooms VALUES (?)', ('ABC123',))
                    database.commit()

                database_ops.PRODUCTION_BACKUPS.mkdir(parents=True)
                for index in range(11):
                    (database_ops.PRODUCTION_BACKUPS / f'control-20000101T0000000000{index}Z-old.sqlite3').touch()

                with patch.object(
                    os,
                    'replace',
                    wraps=os.replace,
                ) as replace_file:
                    backup = database_ops.backup_production_database('2.0.0-test')

                self.assertIsNotNone(backup)
                assert backup is not None
                replace_file.assert_called_once()
                temporary, published = replace_file.call_args.args
                self.assertEqual(Path(temporary).parent, database_ops.PRODUCTION_BACKUPS)
                self.assertTrue(Path(temporary).name.startswith(f'.{backup.name}.backup-'))
                self.assertEqual(Path(published), backup)
                with closing(sqlite3.connect(backup)) as database:
                    self.assertEqual(
                        database.execute('SELECT code FROM rooms').fetchall(),
                        [('ABC123',)],
                    )
                self.assertEqual(
                    len(list(database_ops.PRODUCTION_BACKUPS.glob('control-*.sqlite3'))),
                    common.DATABASE_BACKUP_LIMIT,
                )
                self.assertFalse(
                    list(database_ops.PRODUCTION_BACKUPS.glob('.control-*.backup-*.tmp'))
                )
            finally:
                (
                    database_ops.APP_DIR,
                    database_ops.PRODUCTION_DATA,
                    database_ops.PRODUCTION_DATABASE,
                    database_ops.PRODUCTION_BACKUPS,
                ) = original_values

    def test_database_backup_failure_never_publishes_a_partial_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original_values = (
                database_ops.APP_DIR,
                database_ops.PRODUCTION_DATA,
                database_ops.PRODUCTION_DATABASE,
                database_ops.PRODUCTION_BACKUPS,
            )
            database_ops.APP_DIR = root
            database_ops.PRODUCTION_DATA = root / 'deploy/production/data'
            database_ops.PRODUCTION_DATABASE = (
                database_ops.PRODUCTION_DATA / 'control.sqlite3'
            )
            database_ops.PRODUCTION_BACKUPS = root / 'deploy/production/backups'
            try:
                database_ops.PRODUCTION_DATA.mkdir(parents=True)
                with closing(sqlite3.connect(database_ops.PRODUCTION_DATABASE)) as database:
                    database.execute('CREATE TABLE rooms (code TEXT PRIMARY KEY)')
                    database.execute('INSERT INTO rooms VALUES (?)', ('ATOMIC',))
                    database.commit()
                database_ops.PRODUCTION_BACKUPS.mkdir(parents=True)

                with (
                    patch.object(
                        database_ops,
                        'fsync_file',
                        side_effect=OSError('injected sync failure'),
                    ),
                    self.assertRaisesRegex(SystemExit, 'database backup failed'),
                ):
                    database_ops.backup_production_database('2.0.1-test')

                self.assertFalse(
                    list(database_ops.PRODUCTION_BACKUPS.glob('control-*.sqlite3'))
                )
                self.assertFalse(
                    list(database_ops.PRODUCTION_BACKUPS.glob('.control-*.backup-*.tmp'))
                )
            finally:
                (
                    database_ops.APP_DIR,
                    database_ops.PRODUCTION_DATA,
                    database_ops.PRODUCTION_DATABASE,
                    database_ops.PRODUCTION_BACKUPS,
                ) = original_values

    def test_database_backup_refuses_symlinked_production_ancestor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            deploy_root = root / 'deploy'
            outside_production = root / 'outside-production'
            outside_data = outside_production / 'data'
            deploy_root.mkdir()
            outside_data.mkdir(parents=True)
            production_link = deploy_root / 'production'
            try:
                production_link.symlink_to(outside_production, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest('directory symlinks are unavailable on this platform')
            production_data = production_link / 'data'
            production_database = production_data / 'control.sqlite3'
            with closing(sqlite3.connect(production_database)) as database:
                database.execute('CREATE TABLE current_state (value TEXT)')
            backups = production_link / 'backups'
            original_values = (
                database_ops.APP_DIR,
                database_ops.PRODUCTION_DATA,
                database_ops.PRODUCTION_DATABASE,
                database_ops.PRODUCTION_BACKUPS,
            )
            database_ops.APP_DIR = root
            database_ops.PRODUCTION_DATA = production_data
            database_ops.PRODUCTION_DATABASE = production_database
            database_ops.PRODUCTION_BACKUPS = backups
            try:
                with self.assertRaises(SystemExit):
                    database_ops.backup_production_database('2.0.1-test')
                self.assertFalse((outside_production / 'backups').exists())
            finally:
                (
                    database_ops.APP_DIR,
                    database_ops.PRODUCTION_DATA,
                    database_ops.PRODUCTION_DATABASE,
                    database_ops.PRODUCTION_BACKUPS,
                ) = original_values

    def test_copies_database_consistently_for_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.sqlite3'
            destination = root / 'restored/control.sqlite3'
            with closing(sqlite3.connect(source)) as database:
                database.execute('CREATE TABLE rooms (code TEXT PRIMARY KEY)')
                database.execute('INSERT INTO rooms VALUES (?)', ('RESTORED',))
                database.commit()

            database_ops.copy_sqlite_database(source, destination)

            with closing(sqlite3.connect(destination)) as database:
                self.assertEqual(
                    database.execute('SELECT code FROM rooms').fetchone(),
                    ('RESTORED',),
                )
            database_ops.verify_sqlite_database(destination)

    def test_refuses_to_overwrite_database_outside_explicit_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.sqlite3'
            destination = root / 'destination.sqlite3'
            with closing(sqlite3.connect(source)) as database:
                database.execute('CREATE TABLE source (value TEXT)')
            with closing(sqlite3.connect(destination)) as database:
                database.execute('CREATE TABLE destination (value TEXT)')

            with self.assertRaises(SystemExit):
                database_ops.copy_sqlite_database(source, destination)


if __name__ == '__main__':
    unittest.main()
