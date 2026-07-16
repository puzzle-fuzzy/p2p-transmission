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

    def test_copies_database_consistently_for_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.sqlite3'
            destination = root / 'restored/control.sqlite3'
            with closing(sqlite3.connect(source)) as database:
                database.execute('CREATE TABLE rooms (code TEXT PRIMARY KEY)')
                database.execute('INSERT INTO rooms VALUES (?)', ('RESTORED',))
                database.commit()

            deploy_release.copy_sqlite_database(source, destination)

            with closing(sqlite3.connect(destination)) as database:
                self.assertEqual(
                    database.execute('SELECT code FROM rooms').fetchone(),
                    ('RESTORED',),
                )
            deploy_release.verify_sqlite_database(destination)

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
                deploy_release.copy_sqlite_database(source, destination)


if __name__ == '__main__':
    unittest.main()
