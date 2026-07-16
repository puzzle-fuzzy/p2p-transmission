from __future__ import annotations

import importlib.util
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path


MODULE_PATH = Path(__file__).with_name('deploy-release.py')
SPEC = importlib.util.spec_from_file_location('deploy_release', MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
deploy_release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy_release)


class DeployReleaseTests(unittest.TestCase):
    def test_discovers_previous_rust_compose_without_current_project_name(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy_root = root / 'deploy' / 'legacy-runtime'
            legacy_root.mkdir(parents=True)
            (legacy_root / 'compose.yml').write_text(
                'name: p2p-transmission-legacy\n'
                'services:\n'
                '  app:\n'
                '    image: p2p-transmission-legacy:2.0.1\n'
                '    environment:\n'
                '      P2P_DATABASE_PATH: /app/data/control.sqlite3\n'
                '    ports:\n'
                '      - "127.0.0.1:3410:3410"\n',
                encoding='utf-8',
            )
            original_app_dir = deploy_release.APP_DIR
            deploy_release.APP_DIR = root
            try:
                self.assertEqual(deploy_release.find_legacy_production_root(), legacy_root)
                self.assertEqual(
                    deploy_release.legacy_production_project(legacy_root),
                    'p2p-transmission-legacy',
                )
            finally:
                deploy_release.APP_DIR = original_app_dir

    def test_parses_env_without_exposing_comments(self) -> None:
        values = deploy_release.parse_env_text(
            '# comment\nP2P_TURN_URLS=turn:example.test\nP2P_TURN_SECRET="secret-value"\n'
        )
        self.assertEqual(values['P2P_TURN_URLS'], 'turn:example.test')
        self.assertEqual(values['P2P_TURN_SECRET'], 'secret-value')

    def test_builds_production_env_from_existing_turn_settings(self) -> None:
        values = deploy_release.build_production_env(
            {
                'P2P_TURN_URLS': 'turn:turn.p2p.yxswy.com:3478?transport=udp',
                'P2P_TURN_SECRET': 'turn-secret-0123456789abcdef',
            },
            '2.0.0-abcdef0',
            capability_secret='capability-secret-0123456789abcdef0123456789',
        )
        self.assertEqual(values['P2P_ALLOWED_ORIGINS'], 'https://p2p.yxswy.com')
        self.assertEqual(values['P2P_BIND_IP'], '127.0.0.1')
        self.assertEqual(values['P2P_IMAGE_TAG'], '2.0.0-abcdef0')
        self.assertEqual(values['P2P_TURN_SECRET'], 'turn-secret-0123456789abcdef')

    def test_preserves_existing_secrets_during_update(self) -> None:
        values = deploy_release.build_production_env(
            {
                'P2P_CAPABILITY_SECRET': 'existing-capability-secret-0123456789',
                'P2P_TURN_SECRET': 'existing-turn-secret',
                'P2P_TURN_URLS': 'turns:existing.example:5349',
            },
            '2.0.0-abcdef1',
            capability_secret='unused-capability-secret-0123456789012345',
        )
        self.assertEqual(
            values['P2P_CAPABILITY_SECRET'],
            'existing-capability-secret-0123456789',
        )
        self.assertEqual(values['P2P_TURN_SECRET'], 'existing-turn-secret')

    def test_rejects_newlines_in_env_values(self) -> None:
        with self.assertRaises(ValueError):
            deploy_release.format_env({'P2P_TURN_SECRET': 'secret\ninjected=true'})

    def test_creates_verified_database_backup_and_prunes_old_copies(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original_values = (
                deploy_release.APP_DIR,
                deploy_release.PRODUCTION_DATABASE,
                deploy_release.PRODUCTION_BACKUPS,
            )
            deploy_release.APP_DIR = root
            deploy_release.PRODUCTION_DATABASE = root / 'deploy/production/data/control.sqlite3'
            deploy_release.PRODUCTION_BACKUPS = root / 'deploy/production/backups'
            try:
                deploy_release.PRODUCTION_DATABASE.parent.mkdir(parents=True)
                with closing(sqlite3.connect(deploy_release.PRODUCTION_DATABASE)) as database:
                    database.execute('CREATE TABLE rooms (code TEXT PRIMARY KEY)')
                    database.execute('INSERT INTO rooms VALUES (?)', ('ABC123',))
                    database.commit()

                deploy_release.PRODUCTION_BACKUPS.mkdir(parents=True)
                for index in range(11):
                    (deploy_release.PRODUCTION_BACKUPS / f'control-20000101T0000000000{index}Z-old.sqlite3').touch()

                backup = deploy_release.backup_production_database('2.0.0-test')

                self.assertIsNotNone(backup)
                assert backup is not None
                with closing(sqlite3.connect(backup)) as database:
                    self.assertEqual(
                        database.execute('SELECT code FROM rooms').fetchall(),
                        [('ABC123',)],
                    )
                self.assertEqual(
                    len(list(deploy_release.PRODUCTION_BACKUPS.glob('control-*.sqlite3'))),
                    deploy_release.DATABASE_BACKUP_LIMIT,
                )
            finally:
                (
                    deploy_release.APP_DIR,
                    deploy_release.PRODUCTION_DATABASE,
                    deploy_release.PRODUCTION_BACKUPS,
                ) = original_values

    def test_migrates_database_and_verified_backups_from_previous_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy_root = root / 'deploy' / 'legacy-runtime'
            legacy_data = legacy_root / 'data'
            legacy_backups = legacy_root / 'backups'
            legacy_data.mkdir(parents=True)
            legacy_backups.mkdir(parents=True)

            with closing(sqlite3.connect(legacy_data / 'control.sqlite3')) as database:
                database.execute('CREATE TABLE rooms (code TEXT PRIMARY KEY)')
                database.execute('INSERT INTO rooms VALUES (?)', ('MIGRATED',))
                database.commit()
            with closing(sqlite3.connect(legacy_backups / 'control-20260716.sqlite3')) as database:
                database.execute('CREATE TABLE backups (value TEXT)')
                database.execute('INSERT INTO backups VALUES (?)', ('verified',))
                database.commit()

            original_values = (
                deploy_release.APP_DIR,
                deploy_release.PRODUCTION_DATABASE,
                deploy_release.PRODUCTION_BACKUPS,
            )
            deploy_release.APP_DIR = root
            deploy_release.PRODUCTION_DATABASE = root / 'deploy/production/data/control.sqlite3'
            deploy_release.PRODUCTION_BACKUPS = root / 'deploy/production/backups'
            try:
                self.assertTrue(deploy_release.migrate_legacy_database(legacy_root))
                with closing(sqlite3.connect(deploy_release.PRODUCTION_DATABASE)) as database:
                    self.assertEqual(
                        database.execute('SELECT code FROM rooms').fetchone(),
                        ('MIGRATED',),
                    )
                self.assertEqual(deploy_release.migrate_legacy_backups(legacy_root), 1)
                deploy_release.verify_sqlite_database(
                    deploy_release.PRODUCTION_BACKUPS / 'control-20260716.sqlite3'
                )
            finally:
                (
                    deploy_release.APP_DIR,
                    deploy_release.PRODUCTION_DATABASE,
                    deploy_release.PRODUCTION_BACKUPS,
                ) = original_values


if __name__ == '__main__':
    unittest.main()
