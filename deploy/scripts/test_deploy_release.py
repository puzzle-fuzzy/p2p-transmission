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
    def test_parses_legacy_env_without_exposing_comments(self) -> None:
        values = deploy_release.parse_env_text(
            '# comment\nTURN_URLS=turn:example.test\nTURN_SHARED_SECRET="secret-value"\n'
        )
        self.assertEqual(values['TURN_URLS'], 'turn:example.test')
        self.assertEqual(values['TURN_SHARED_SECRET'], 'secret-value')

    def test_builds_production_v2_env_from_legacy_turn_settings(self) -> None:
        values = deploy_release.build_v2_env(
            {},
            {
                'TURN_URLS': 'turn:turn.p2p.yxswy.com:3478?transport=udp',
                'TURN_SHARED_SECRET': 'turn-secret-0123456789abcdef',
            },
            '2.0.0-abcdef0',
            capability_secret='capability-secret-0123456789abcdef0123456789',
        )
        self.assertEqual(values['P2P_ALLOWED_ORIGINS'], 'https://p2p.yxswy.com')
        self.assertEqual(values['P2P_BIND_IP'], '127.0.0.1')
        self.assertEqual(values['P2P_IMAGE_TAG'], '2.0.0-abcdef0')
        self.assertEqual(values['P2P_TURN_SECRET'], 'turn-secret-0123456789abcdef')

    def test_preserves_existing_v2_secrets_during_update(self) -> None:
        values = deploy_release.build_v2_env(
            {
                'P2P_CAPABILITY_SECRET': 'existing-capability-secret-0123456789',
                'P2P_TURN_SECRET': 'existing-turn-secret',
                'P2P_TURN_URLS': 'turns:existing.example:5349',
            },
            {},
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
                deploy_release.V2_DATABASE,
                deploy_release.V2_BACKUPS,
            )
            deploy_release.APP_DIR = root
            deploy_release.V2_DATABASE = root / 'deploy/v2/data/control.sqlite3'
            deploy_release.V2_BACKUPS = root / 'deploy/v2/backups'
            try:
                deploy_release.V2_DATABASE.parent.mkdir(parents=True)
                with closing(sqlite3.connect(deploy_release.V2_DATABASE)) as database:
                    database.execute('CREATE TABLE rooms (code TEXT PRIMARY KEY)')
                    database.execute('INSERT INTO rooms VALUES (?)', ('ABC123',))
                    database.commit()

                deploy_release.V2_BACKUPS.mkdir(parents=True)
                for index in range(11):
                    (deploy_release.V2_BACKUPS / f'control-20000101T0000000000{index}Z-old.sqlite3').touch()

                backup = deploy_release.backup_v2_database('2.0.0-test')

                self.assertIsNotNone(backup)
                assert backup is not None
                with closing(sqlite3.connect(backup)) as database:
                    self.assertEqual(
                        database.execute('SELECT code FROM rooms').fetchall(),
                        [('ABC123',)],
                    )
                self.assertEqual(
                    len(list(deploy_release.V2_BACKUPS.glob('control-*.sqlite3'))),
                    deploy_release.DATABASE_BACKUP_LIMIT,
                )
            finally:
                (
                    deploy_release.APP_DIR,
                    deploy_release.V2_DATABASE,
                    deploy_release.V2_BACKUPS,
                ) = original_values


if __name__ == '__main__':
    unittest.main()
