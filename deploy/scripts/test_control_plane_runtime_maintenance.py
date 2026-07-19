from __future__ import annotations

import shutil
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from deploy_control_plane import capacity
from deploy_control_plane import common
from deploy_control_plane import database as database_ops
from deploy_control_plane import runtime


INTERNAL_METRICS = {name: 0 for name in common.REQUIRED_INTERNAL_METRICS}


class ControlPlaneRuntimeMaintenanceTests(unittest.TestCase):
    def test_maintenance_creates_and_restore_drills_a_missing_backup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            production_data = root / 'deploy/production/data'
            production_database = production_data / 'control.sqlite3'
            backups_root = root / 'deploy/production/backups'
            pending_release = root / 'deploy/production/rollback/pending.json'
            production_env = root / 'deploy/production/.env'
            original_values = (
                runtime.PRODUCTION_DATA,
                runtime.PRODUCTION_DATABASE,
                runtime.PRODUCTION_ENV,
                runtime.PENDING_RELEASE,
                database_ops.APP_DIR,
                database_ops.PRODUCTION_DATA,
                database_ops.PRODUCTION_DATABASE,
                database_ops.PRODUCTION_BACKUPS,
                capacity.PRODUCTION_BACKUPS,
            )
            runtime.PRODUCTION_DATA = production_data
            runtime.PRODUCTION_DATABASE = production_database
            runtime.PRODUCTION_ENV = production_env
            runtime.PENDING_RELEASE = pending_release
            database_ops.APP_DIR = root
            database_ops.PRODUCTION_DATA = production_data
            database_ops.PRODUCTION_DATABASE = production_database
            database_ops.PRODUCTION_BACKUPS = backups_root
            capacity.PRODUCTION_BACKUPS = backups_root
            try:
                production_data.mkdir(parents=True)
                production_env.write_text(
                    'P2P_OFFSITE_BACKUP_REMOTE=test:backups\n'
                    'P2P_OFFSITE_BACKUP_AGE_RECIPIENT=age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq\n'
                    'P2P_OFFSITE_BACKUP_AGE_IDENTITY=/root/backup.agekey\n',
                    encoding='utf-8',
                )
                with closing(sqlite3.connect(production_database)) as database:
                    database.execute('CREATE TABLE rooms (code TEXT PRIMARY KEY)')
                    database.execute('INSERT INTO rooms VALUES (?)', ('DRILL1',))
                    database.commit()

                with (
                    patch.object(
                        runtime,
                        'current_production_release',
                        return_value='2.0.1-test',
                    ),
                    patch.object(
                        runtime,
                        'production_runtime_matches',
                        return_value=True,
                    ),
                    patch.object(
                        shutil,
                        'disk_usage',
                        return_value=SimpleNamespace(
                    free=common.DISK_SAFETY_MARGIN_BYTES
                            + 16 * 1024 * 1024
                        ),
                    ),
                    patch.object(
                        runtime,
                        'fetch_internal_metrics',
                        return_value=INTERNAL_METRICS,
                    ),
                    patch.object(
                        runtime.offsite_backup,
                        'sync_and_drill_offsite_backup',
                        return_value={
                            'remote_object': 'test:backups/control.age',
                            'restore_drill_bytes': 4096,
                            'uploaded': True,
                        },
                    ),
                ):
                    result = runtime.maintain_production()

                self.assertEqual(result['status'], 'healthy')
                self.assertTrue(result['backup_created'])
                self.assertEqual(result['metrics'], INTERNAL_METRICS)
                self.assertGreater(result['restore_drill_bytes'], 0)
                self.assertEqual(result['offsite_backup']['uploaded'], True)
                backups = list(backups_root.glob('control-*.sqlite3'))
                self.assertEqual(len(backups), 1)
                self.assertFalse(list(backups_root.glob('.restore-drill-*')))
            finally:
                (
                    runtime.PRODUCTION_DATA,
                    runtime.PRODUCTION_DATABASE,
                    runtime.PRODUCTION_ENV,
                    runtime.PENDING_RELEASE,
                    database_ops.APP_DIR,
                    database_ops.PRODUCTION_DATA,
                    database_ops.PRODUCTION_DATABASE,
                    database_ops.PRODUCTION_BACKUPS,
                    capacity.PRODUCTION_BACKUPS,
                ) = original_values

    def test_maintenance_reuses_a_recent_verified_backup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            production_data = root / 'deploy/production/data'
            production_database = production_data / 'control.sqlite3'
            backups_root = root / 'deploy/production/backups'
            pending_release = root / 'deploy/production/rollback/pending.json'
            production_env = root / 'deploy/production/.env'
            original_values = (
                runtime.PRODUCTION_DATA,
                runtime.PRODUCTION_DATABASE,
                runtime.PRODUCTION_ENV,
                runtime.PENDING_RELEASE,
                database_ops.APP_DIR,
                database_ops.PRODUCTION_DATA,
                database_ops.PRODUCTION_DATABASE,
                database_ops.PRODUCTION_BACKUPS,
                capacity.PRODUCTION_BACKUPS,
            )
            runtime.PRODUCTION_DATA = production_data
            runtime.PRODUCTION_DATABASE = production_database
            runtime.PRODUCTION_ENV = production_env
            runtime.PENDING_RELEASE = pending_release
            database_ops.APP_DIR = root
            database_ops.PRODUCTION_DATA = production_data
            database_ops.PRODUCTION_DATABASE = production_database
            database_ops.PRODUCTION_BACKUPS = backups_root
            capacity.PRODUCTION_BACKUPS = backups_root
            try:
                production_data.mkdir(parents=True)
                backups_root.mkdir(parents=True)
                production_env.write_text(
                    'P2P_OFFSITE_BACKUP_REMOTE=test:backups\n'
                    'P2P_OFFSITE_BACKUP_AGE_RECIPIENT=age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq\n'
                    'P2P_OFFSITE_BACKUP_AGE_IDENTITY=/root/backup.agekey\n',
                    encoding='utf-8',
                )
                with closing(sqlite3.connect(production_database)) as database:
                    database.execute('CREATE TABLE rooms (code TEXT PRIMARY KEY)')
                    database.execute('INSERT INTO rooms VALUES (?)', ('LIVE',))
                    database.commit()
                backup = backups_root / 'control-recent.sqlite3'
                database_ops.copy_sqlite_database(production_database, backup)

                with (
                    patch.object(
                        runtime,
                        'current_production_release',
                        return_value='2.0.1-test',
                    ),
                    patch.object(
                        runtime,
                        'production_runtime_matches',
                        return_value=True,
                    ),
                    patch.object(
                        shutil,
                        'disk_usage',
                        return_value=SimpleNamespace(
                    free=common.DISK_SAFETY_MARGIN_BYTES
                            + 16 * 1024 * 1024
                        ),
                    ),
                    patch.object(
                        runtime,
                        'fetch_internal_metrics',
                        return_value=INTERNAL_METRICS,
                    ),
                    patch.object(runtime, 'backup_production_database') as create_backup,
                    patch.object(
                        runtime.offsite_backup,
                        'sync_and_drill_offsite_backup',
                        return_value={
                            'remote_object': 'test:backups/control.age',
                            'restore_drill_bytes': 4096,
                            'uploaded': False,
                        },
                    ),
                ):
                    result = runtime.maintain_production()

                create_backup.assert_not_called()
                self.assertFalse(result['backup_created'])
                self.assertEqual(result['backup'], backup.name)
            finally:
                (
                    runtime.PRODUCTION_DATA,
                    runtime.PRODUCTION_DATABASE,
                    runtime.PRODUCTION_ENV,
                    runtime.PENDING_RELEASE,
                    database_ops.APP_DIR,
                    database_ops.PRODUCTION_DATA,
                    database_ops.PRODUCTION_DATABASE,
                    database_ops.PRODUCTION_BACKUPS,
                    capacity.PRODUCTION_BACKUPS,
                ) = original_values

    def test_maintenance_refuses_a_pending_release(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            pending = Path(directory) / 'pending.json'
            pending.write_text('{}', encoding='utf-8')
            with patch.object(runtime, 'PENDING_RELEASE', pending):
                with self.assertRaisesRegex(SystemExit, 'release is pending'):
                    runtime.maintain_production()


if __name__ == '__main__':
    unittest.main()
