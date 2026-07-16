from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name('deploy-release.py')
PRODUCTION_COMPOSE = MODULE_PATH.parent.parent / 'production' / 'compose.yml'
SPEC = importlib.util.spec_from_file_location('deploy_release', MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
deploy_release = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = deploy_release
SPEC.loader.exec_module(deploy_release)


class DeployReleaseTests(unittest.TestCase):
    def test_compose_build_release_matches_the_image_tag(self) -> None:
        compose = PRODUCTION_COMPOSE.read_text(encoding='utf-8')
        self.assertIn(
            'P2P_RELEASE_VERSION: ${P2P_IMAGE_TAG:-2.0.1}',
            compose,
        )

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

    def test_readiness_requires_the_exact_release(self) -> None:
        payload = {
            'status': 'ready',
            'service': 'p2p-server',
            'version': '2.0.1',
            'release': '2.0.1-abcdef0',
        }
        self.assertTrue(deploy_release.readiness_matches(payload, '2.0.1-abcdef0'))
        self.assertFalse(deploy_release.readiness_matches(payload, '2.0.1-abcdef1'))
        self.assertFalse(
            deploy_release.readiness_matches({**payload, 'release': ''}, '2.0.1-abcdef0')
        )
        unversioned = {key: value for key, value in payload.items() if key != 'release'}
        self.assertFalse(deploy_release.readiness_matches(unversioned, '2.0.1-abcdef0'))

    def test_deployment_requires_the_previous_rollback_image(self) -> None:
        with patch.object(deploy_release, 'image_exists', return_value=True):
            self.assertEqual(
                deploy_release.require_rollback_image('2.0.1-abcdef0'),
                'p2p-transmission:2.0.1-abcdef0',
            )
        with patch.object(deploy_release, 'image_exists', return_value=False):
            with self.assertRaises(SystemExit):
                deploy_release.require_rollback_image('2.0.1-missing')
        with self.assertRaises(SystemExit):
            deploy_release.require_rollback_image(None)

    def test_removes_only_retired_tracked_source_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old_source = root / 'retired/frontend/client.js'
            untracked_cache = root / 'retired/frontend/cache/package/index.js'
            current_source = root / 'rust/apps/server/src/main.rs'
            production_env = root / 'deploy/production/.env'
            for path in (old_source, untracked_cache, current_source, production_env):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture', encoding='utf-8')

            original_values = deploy_release.APP_DIR, deploy_release.SOURCE_MANIFEST
            deploy_release.APP_DIR = root
            deploy_release.SOURCE_MANIFEST = root / 'deploy/production/source-files.json'
            try:
                removed = deploy_release.remove_retired_source_files(
                    {'rust/apps/server/src/main.rs'},
                    {'retired/frontend/client.js', 'deploy/production/.env'},
                )
                deploy_release.write_source_manifest({'rust/apps/server/src/main.rs'})
                self.assertEqual(removed, 1)
                self.assertFalse(old_source.exists())
                self.assertTrue(untracked_cache.is_file())
                self.assertTrue(current_source.is_file())
                self.assertTrue(production_env.is_file())
                self.assertEqual(
                    json.loads(deploy_release.SOURCE_MANIFEST.read_text(encoding='utf-8')),
                    ['rust/apps/server/src/main.rs'],
                )
            finally:
                deploy_release.APP_DIR, deploy_release.SOURCE_MANIFEST = original_values

    def test_existing_source_manifest_wins_over_bootstrap_diff(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stale = root / 'retired/service/src/main.rs'
            bootstrap_only = root / 'docs/keep.md'
            for path in (stale, bootstrap_only):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture', encoding='utf-8')

            original_values = deploy_release.APP_DIR, deploy_release.SOURCE_MANIFEST
            deploy_release.APP_DIR = root
            deploy_release.SOURCE_MANIFEST = root / 'deploy/production/source-files.json'
            deploy_release.SOURCE_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
            deploy_release.SOURCE_MANIFEST.write_text(
                json.dumps(['retired/service/src/main.rs']),
                encoding='utf-8',
            )
            try:
                deploy_release.remove_retired_source_files(set(), {'docs/keep.md'})
                self.assertFalse(stale.exists())
                self.assertTrue(bootstrap_only.is_file())
            finally:
                deploy_release.APP_DIR, deploy_release.SOURCE_MANIFEST = original_values

    def test_retired_source_cleanup_rejects_intermediate_symbolic_links(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            sandbox = Path(directory)
            root = sandbox / 'application'
            outside = sandbox / 'outside'
            root.mkdir()
            outside.mkdir()
            victim = outside / 'victim.txt'
            victim.write_text('must survive', encoding='utf-8')
            linked = root / 'linked'
            try:
                linked.symlink_to(outside, target_is_directory=True)
            except OSError as error:
                self.skipTest(f'symbolic links are unavailable: {error}')

            original_values = deploy_release.APP_DIR, deploy_release.SOURCE_MANIFEST
            deploy_release.APP_DIR = root
            deploy_release.SOURCE_MANIFEST = root / 'deploy/production/source-files.json'
            try:
                with self.assertRaises(SystemExit):
                    deploy_release.remove_retired_source_files(set(), {'linked/victim.txt'})
                self.assertEqual(victim.read_text(encoding='utf-8'), 'must survive')
            finally:
                deploy_release.APP_DIR, deploy_release.SOURCE_MANIFEST = original_values

    def test_invalid_environment_is_not_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            production_env = root / 'deploy/production/.env'
            production_data = root / 'deploy/production/data'
            production_env.parent.mkdir(parents=True)
            original = b'P2P_IMAGE_TAG=2.0.1-abcdef0\n'
            production_env.write_bytes(original)

            original_values = (
                deploy_release.PRODUCTION_ENV,
                deploy_release.PRODUCTION_DATA,
            )
            deploy_release.PRODUCTION_ENV = production_env
            deploy_release.PRODUCTION_DATA = production_data
            try:
                with self.assertRaises(SystemExit):
                    deploy_release.prepare_production_environment('2.0.1-abcdef1', original)
                self.assertEqual(production_env.read_bytes(), original)
                self.assertFalse(production_data.exists())
            finally:
                (
                    deploy_release.PRODUCTION_ENV,
                    deploy_release.PRODUCTION_DATA,
                ) = original_values

    def test_rollback_requires_every_asset_and_old_runtime_readiness(self) -> None:
        preflight = deploy_release.ProductionPreflight(
            previous_env=b'P2P_IMAGE_TAG=old\n',
            previous_tag='2.0.1-abcdef0',
            database_backup=None,
            nginx_snapshot=Path('/run/nginx-snapshot'),
            compose_snapshot=Path('/run/compose-snapshot'),
            expected_image='p2p-transmission:2.0.1-new',
        )
        with (
            patch.object(deploy_release, 'best_effort', return_value=True) as best_effort,
            patch.object(deploy_release, 'restore_production_database', return_value=True),
            patch.object(deploy_release, 'restore_nginx', return_value=True),
            patch.object(deploy_release, 'restore_compose', return_value=True),
            patch.object(deploy_release, 'restore_production_environment'),
            patch.object(deploy_release, 'wait_for_readiness', return_value=True) as ready,
        ):
            deploy_release.rollback_runtime(preflight)
            self.assertEqual(best_effort.call_count, 3)
            ready.assert_called_once_with('2.0.1-abcdef0')

        with (
            patch.object(deploy_release, 'best_effort', return_value=True) as best_effort,
            patch.object(deploy_release, 'restore_production_database', return_value=False),
            patch.object(deploy_release, 'restore_nginx', return_value=True),
            patch.object(deploy_release, 'restore_compose', return_value=True),
            patch.object(deploy_release, 'restore_production_environment'),
            patch.object(deploy_release, 'wait_for_readiness') as ready,
        ):
            with self.assertRaises(SystemExit):
                deploy_release.rollback_runtime(preflight)
            self.assertEqual(best_effort.call_count, 2)
            ready.assert_not_called()

        with (
            patch.object(deploy_release, 'best_effort') as best_effort,
            patch.object(deploy_release, 'restore_production_database') as restore_database,
            patch.object(deploy_release, 'restore_nginx', return_value=False),
            patch.object(deploy_release, 'restore_compose', return_value=True),
            patch.object(deploy_release, 'restore_production_environment'),
            patch.object(deploy_release, 'wait_for_readiness') as ready,
        ):
            with self.assertRaises(SystemExit):
                deploy_release.rollback_runtime(preflight)
            best_effort.assert_not_called()
            restore_database.assert_not_called()
            ready.assert_not_called()

    def test_snapshot_cleanup_is_best_effort(self) -> None:
        preflight = deploy_release.ProductionPreflight(
            previous_env=b'',
            previous_tag='2.0.1-abcdef0',
            database_backup=None,
            nginx_snapshot=Path('/run/nginx-snapshot'),
            compose_snapshot=Path('/run/compose-snapshot'),
            expected_image='p2p-transmission:2.0.1-new',
        )
        with patch.object(Path, 'unlink', side_effect=[OSError('busy'), None]):
            self.assertFalse(preflight.cleanup_snapshots())

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
