from __future__ import annotations

import importlib.util
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name('deploy-release.py')
PRODUCTION_COMPOSE = MODULE_PATH.parent.parent / 'production' / 'compose.yml'
PRODUCTION_WORKFLOW = MODULE_PATH.parents[2] / '.github' / 'workflows' / 'production.yml'
SPEC = importlib.util.spec_from_file_location('deploy_release', MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
deploy_release = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = deploy_release
SPEC.loader.exec_module(deploy_release)


class DeployReleaseTests(unittest.TestCase):
    def test_helper_protocol_version_is_explicit_and_side_effect_free(self) -> None:
        result = subprocess.run(
            [sys.executable, str(MODULE_PATH), 'protocol-version'],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), '2')

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
            patch.object(deploy_release, 'mark_pending_rollback_database_restored') as marked,
            patch.object(deploy_release, 'wait_for_readiness', return_value=True) as ready,
        ):
            deploy_release.rollback_runtime(preflight)
            self.assertEqual(best_effort.call_count, 3)
            marked.assert_called_once_with('2.0.1-new')
            ready.assert_called_once_with('2.0.1-abcdef0')

        with (
            patch.object(deploy_release, 'best_effort', return_value=True) as best_effort,
            patch.object(deploy_release, 'restore_production_database', return_value=False),
            patch.object(deploy_release, 'restore_nginx', return_value=True),
            patch.object(deploy_release, 'restore_compose', return_value=True),
            patch.object(deploy_release, 'restore_production_environment'),
            patch.object(deploy_release, 'mark_pending_rollback_database_restored') as marked,
            patch.object(deploy_release, 'wait_for_readiness') as ready,
        ):
            with self.assertRaises(SystemExit):
                deploy_release.rollback_runtime(preflight)
            self.assertEqual(best_effort.call_count, 2)
            marked.assert_not_called()
            ready.assert_not_called()

        with (
            patch.object(deploy_release, 'best_effort') as best_effort,
            patch.object(deploy_release, 'restore_production_database') as restore_database,
            patch.object(deploy_release, 'restore_nginx', return_value=False),
            patch.object(deploy_release, 'restore_compose', return_value=True),
            patch.object(deploy_release, 'restore_production_environment'),
            patch.object(deploy_release, 'mark_pending_rollback_database_restored') as marked,
            patch.object(deploy_release, 'wait_for_readiness') as ready,
        ):
            with self.assertRaises(SystemExit):
                deploy_release.rollback_runtime(preflight)
            best_effort.assert_not_called()
            marked.assert_not_called()
            restore_database.assert_not_called()
            ready.assert_not_called()

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
                deploy_release.APP_DIR,
                deploy_release.PRODUCTION_DATA,
                deploy_release.PRODUCTION_DATABASE,
            )
            deploy_release.APP_DIR = root
            deploy_release.PRODUCTION_DATA = production_data
            deploy_release.PRODUCTION_DATABASE = production_database
            try:
                with patch.object(deploy_release, 'fsync_directory') as synced:
                    self.assertTrue(deploy_release.restore_production_database(None))
                synced.assert_called_once_with(production_data)
                self.assertFalse(production_database.exists())
                self.assertFalse(Path(f'{production_database}-wal').exists())
                self.assertFalse(Path(f'{production_database}-shm').exists())
            finally:
                (
                    deploy_release.APP_DIR,
                    deploy_release.PRODUCTION_DATA,
                    deploy_release.PRODUCTION_DATABASE,
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
                deploy_release.APP_DIR,
                deploy_release.PRODUCTION_DATA,
                deploy_release.PRODUCTION_DATABASE,
            )
            deploy_release.APP_DIR = root
            deploy_release.PRODUCTION_DATA = production_data
            deploy_release.PRODUCTION_DATABASE = production_database
            try:
                self.assertTrue(deploy_release.restore_production_database(backup))
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
                    deploy_release.APP_DIR,
                    deploy_release.PRODUCTION_DATA,
                    deploy_release.PRODUCTION_DATABASE,
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
                deploy_release.APP_DIR,
                deploy_release.PRODUCTION_DATA,
                deploy_release.PRODUCTION_DATABASE,
            )
            deploy_release.APP_DIR = root
            deploy_release.PRODUCTION_DATA = production_data
            deploy_release.PRODUCTION_DATABASE = production_database
            try:
                self.assertFalse(deploy_release.restore_production_database(backup))
                self.assertEqual(production_database.read_bytes(), b'current database')
                self.assertEqual(wal.read_bytes(), b'current wal')
                self.assertEqual(shm.read_bytes(), b'current shm')
            finally:
                (
                    deploy_release.APP_DIR,
                    deploy_release.PRODUCTION_DATA,
                    deploy_release.PRODUCTION_DATABASE,
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
                deploy_release.APP_DIR,
                deploy_release.PRODUCTION_DATA,
                deploy_release.PRODUCTION_DATABASE,
            )
            deploy_release.APP_DIR = root
            deploy_release.PRODUCTION_DATA = production_data
            deploy_release.PRODUCTION_DATABASE = production_database
            try:
                self.assertFalse(deploy_release.restore_production_database(None))
                self.assertTrue(production_database.exists())
            finally:
                (
                    deploy_release.APP_DIR,
                    deploy_release.PRODUCTION_DATA,
                    deploy_release.PRODUCTION_DATABASE,
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
                deploy_release.APP_DIR,
                deploy_release.PRODUCTION_DATA,
                deploy_release.PRODUCTION_DATABASE,
            )
            deploy_release.APP_DIR = root
            deploy_release.PRODUCTION_DATA = data_link
            deploy_release.PRODUCTION_DATABASE = production_database
            try:
                self.assertFalse(deploy_release.restore_production_database(None))
                self.assertTrue((outside / 'control.sqlite3').exists())
            finally:
                (
                    deploy_release.APP_DIR,
                    deploy_release.PRODUCTION_DATA,
                    deploy_release.PRODUCTION_DATABASE,
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
                deploy_release.APP_DIR,
                deploy_release.PRODUCTION_DATA,
                deploy_release.PRODUCTION_DATABASE,
            )
            deploy_release.APP_DIR = root
            deploy_release.PRODUCTION_DATA = production_data
            deploy_release.PRODUCTION_DATABASE = production_database
            try:
                self.assertFalse(deploy_release.restore_production_database(None))
                self.assertEqual(
                    (outside_data / 'control.sqlite3').read_bytes(),
                    b'must remain outside',
                )
            finally:
                (
                    deploy_release.APP_DIR,
                    deploy_release.PRODUCTION_DATA,
                    deploy_release.PRODUCTION_DATABASE,
                ) = original_values

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

    def test_staged_release_retains_rollback_state_until_finalize(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rollback_root = root / 'deploy/production/rollback'
            rollback_root.mkdir(parents=True)
            nginx_snapshot = rollback_root / 'p2p-transmission-nginx-test'
            compose_snapshot = rollback_root / 'p2p-transmission-compose-test'
            nginx_snapshot.write_text('old nginx', encoding='utf-8')
            compose_snapshot.write_text('old compose', encoding='utf-8')
            preflight = deploy_release.ProductionPreflight(
                previous_env=b'P2P_IMAGE_TAG=2.0.1-old\n',
                previous_tag='2.0.1-old',
                database_backup=None,
                nginx_snapshot=nginx_snapshot,
                compose_snapshot=compose_snapshot,
                expected_image='p2p-transmission:2.0.1-new',
            )
            with (
                patch.object(deploy_release, 'APP_DIR', root),
                patch.object(deploy_release, 'PRODUCTION_ROLLBACK', rollback_root),
                patch.object(deploy_release, 'PENDING_RELEASE', rollback_root / 'pending.json'),
                patch.object(deploy_release, 'wait_for_production_ready') as ready,
            ):
                deploy_release.write_pending_release(preflight, '2.0.1-new')
                self.assertTrue(deploy_release.PENDING_RELEASE.is_file())
                self.assertTrue(nginx_snapshot.is_file())
                self.assertTrue(compose_snapshot.is_file())

                loaded = deploy_release.load_pending_release('2.0.1-new')
                self.assertEqual(loaded.previous_tag, '2.0.1-old')
                self.assertFalse(loaded.database_may_have_changed)
                self.assertFalse(loaded.rollback_database_restored)
                deploy_release.finalize_pending_release('2.0.1-new')

                ready.assert_called_once_with('2.0.1-new')
                self.assertFalse(deploy_release.PENDING_RELEASE.exists())
                self.assertFalse(nginx_snapshot.exists())
                self.assertFalse(compose_snapshot.exists())

    def test_pending_release_rejects_a_different_version(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rollback_root = root / 'deploy/production/rollback'
            rollback_root.mkdir(parents=True)
            nginx_snapshot = rollback_root / 'p2p-transmission-nginx-test'
            compose_snapshot = rollback_root / 'p2p-transmission-compose-test'
            nginx_snapshot.touch()
            compose_snapshot.touch()
            preflight = deploy_release.ProductionPreflight(
                previous_env=b'P2P_IMAGE_TAG=2.0.1-old\n',
                previous_tag='2.0.1-old',
                database_backup=None,
                nginx_snapshot=nginx_snapshot,
                compose_snapshot=compose_snapshot,
                expected_image='p2p-transmission:2.0.1-new',
            )
            with (
                patch.object(deploy_release, 'APP_DIR', root),
                patch.object(deploy_release, 'PRODUCTION_ROLLBACK', rollback_root),
                patch.object(deploy_release, 'PENDING_RELEASE', rollback_root / 'pending.json'),
            ):
                deploy_release.write_pending_release(preflight, '2.0.1-new')
                with self.assertRaises(SystemExit):
                    deploy_release.load_pending_release('2.0.1-other')
                with self.assertRaises(SystemExit):
                    deploy_release.ensure_no_pending_release()

    def test_pending_release_can_run_the_existing_automatic_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rollback_root = root / 'deploy/production/rollback'
            rollback_root.mkdir(parents=True)
            nginx_snapshot = rollback_root / 'p2p-transmission-nginx-test'
            compose_snapshot = rollback_root / 'p2p-transmission-compose-test'
            nginx_snapshot.touch()
            compose_snapshot.touch()
            preflight = deploy_release.ProductionPreflight(
                previous_env=b'P2P_IMAGE_TAG=2.0.1-old\n',
                previous_tag='2.0.1-old',
                database_backup=None,
                nginx_snapshot=nginx_snapshot,
                compose_snapshot=compose_snapshot,
                expected_image='p2p-transmission:2.0.1-new',
            )
            with (
                patch.object(deploy_release, 'APP_DIR', root),
                patch.object(deploy_release, 'PRODUCTION_ROLLBACK', rollback_root),
                patch.object(deploy_release, 'PENDING_RELEASE', rollback_root / 'pending.json'),
                patch.object(deploy_release, 'restore_pre_runtime_state') as restore_files,
                patch.object(deploy_release, 'rollback_runtime') as rollback,
            ):
                deploy_release.write_pending_release(preflight, '2.0.1-new')
                deploy_release.rollback_pending_release('2.0.1-new')

                restore_files.assert_called_once()
                restored = restore_files.call_args.args[0]
                self.assertEqual(restored.previous_tag, '2.0.1-old')
                rollback.assert_not_called()
                self.assertFalse(deploy_release.PENDING_RELEASE.exists())
                self.assertFalse(nginx_snapshot.exists())
                self.assertFalse(compose_snapshot.exists())

    def test_rollback_is_a_safe_noop_when_stage_never_created_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            pending = Path(directory) / 'pending.json'
            with patch.object(deploy_release, 'PENDING_RELEASE', pending):
                deploy_release.rollback_pending_release('2.0.1-new')

    def test_legacy_operation_binds_the_exact_database_backup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backups = root / 'deploy/production/backups'
            backups.mkdir(parents=True)
            backup = backups / 'control-20260717T000000000000Z-2.0.1-new.sqlite3'
            with closing(sqlite3.connect(backup)) as database:
                database.execute('CREATE TABLE rooms (code TEXT PRIMARY KEY)')
            backup.chmod(0o600)
            payload = {
                'database_backup': str(backup),
                'database_backup_not_required': False,
            }
            with (
                patch.object(deploy_release, 'APP_DIR', root),
                patch.object(deploy_release, 'PRODUCTION_BACKUPS', backups),
            ):
                self.assertEqual(
                    deploy_release.legacy_operation_database_backup(payload, '2.0.1-new'),
                    backup.resolve(),
                )
                with self.assertRaises(SystemExit):
                    deploy_release.legacy_operation_database_backup(payload, '2.0.1-other')

    def test_legacy_operation_state_must_be_finished_and_operation_bound(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            operation_id = 'a' * 40
            state = Path(directory) / f'p2p-transmission-legacy-{operation_id}-status.json'
            payload = {
                'schema': 1,
                'operation_id': operation_id,
                'version': '2.0.1-new',
                'mode': 'legacy',
                'exit_code': 0,
                'finished': True,
                'database_backup': None,
                'database_backup_not_required': True,
            }
            state.write_text(json.dumps(payload), encoding='utf-8')
            state.chmod(0o600)
            with patch.object(deploy_release, 'validate_tmp_file', return_value=state):
                self.assertEqual(
                    deploy_release.load_legacy_operation(state, '2.0.1-new'),
                    payload,
                )
                state.write_text(
                    json.dumps({**payload, 'finished': False}),
                    encoding='utf-8',
                )
                with self.assertRaises(SystemExit):
                    deploy_release.load_legacy_operation(state, '2.0.1-new')
                state.write_text(
                    json.dumps({**payload, 'mode': 'v2'}),
                    encoding='utf-8',
                )
                with self.assertRaises(SystemExit):
                    deploy_release.load_legacy_operation(state, '2.0.1-new')

    def test_adopts_a_finished_legacy_operation_with_its_preimages(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            production_env = root / '.env'
            current_values = deploy_release.build_production_env(
                {
                    'P2P_TURN_URLS': 'turn:turn.example:3478',
                    'P2P_TURN_SECRET': 'turn-secret-0123456789',
                    'P2P_CAPABILITY_SECRET': 'capability-secret-0123456789012345',
                },
                '2.0.1-new',
            )
            production_env.write_text(
                deploy_release.format_env(current_values),
                encoding='utf-8',
            )
            operation_id = 'a' * 40
            operation_state = root / f'p2p-transmission-legacy-{operation_id}-status.json'
            compose_source = root / f'p2p-transmission-legacy-{operation_id}-compose.yml'
            nginx_source = root / f'p2p-transmission-legacy-{operation_id}-nginx.conf'
            protected_nginx = root / 'protected-nginx'
            protected_compose = root / 'protected-compose'
            operation = {
                'schema': 1,
                'version': '2.0.1-new',
                'mode': 'legacy',
                'exit_code': 0,
                'finished': True,
                'database_backup': None,
                'database_backup_not_required': True,
            }
            with (
                patch.object(deploy_release, 'PRODUCTION_ENV', production_env),
                patch.object(deploy_release, 'ensure_no_pending_release'),
                patch.object(deploy_release, 'load_legacy_operation', return_value=operation),
                patch.object(deploy_release, 'production_runtime_matches', return_value=True),
                patch.object(
                    deploy_release,
                    'require_rollback_image',
                    return_value='p2p-transmission:2.0.1-old',
                ),
                patch.object(deploy_release, 'image_id', return_value='sha256:old'),
                patch.object(
                    deploy_release,
                    'legacy_operation_database_backup',
                    return_value=None,
                ),
                patch.object(
                    deploy_release,
                    'protect_legacy_runtime_snapshot',
                    side_effect=[protected_nginx, protected_compose],
                ),
                patch.object(deploy_release, 'write_pending_release') as write_pending,
            ):
                deploy_release.adopt_legacy_pending_release(
                    '2.0.1-new',
                    '2.0.1-old',
                    operation_state,
                    compose_source,
                    nginx_source,
                    'a' * 64,
                    'b' * 64,
                )

            preflight, version = write_pending.call_args.args
            self.assertEqual(version, '2.0.1-new')
            self.assertEqual(preflight.previous_tag, '2.0.1-old')
            self.assertEqual(
                deploy_release.parse_env_text(preflight.previous_env.decode('utf-8'))[
                    'P2P_IMAGE_TAG'
                ],
                '2.0.1-old',
            )
            self.assertEqual(preflight.nginx_snapshot, protected_nginx)
            self.assertEqual(preflight.compose_snapshot, protected_compose)
            self.assertTrue(preflight.database_may_have_changed)

    def test_legacy_rollback_refuses_a_mixed_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            pending = Path(directory) / 'pending.json'
            with (
                patch.object(deploy_release, 'PENDING_RELEASE', pending),
                patch.object(deploy_release, 'load_legacy_operation'),
                patch.object(deploy_release, 'production_runtime_matches', return_value=False),
                patch.object(deploy_release, 'adopt_legacy_pending_release') as adopt,
            ):
                with self.assertRaises(SystemExit):
                    deploy_release.rollback_pending_release(
                        '2.0.1-new',
                        bootstrap_previous_version='2.0.1-old',
                        bootstrap_operation_state=Path('/tmp/state.json'),
                        bootstrap_compose_snapshot=Path('/tmp/compose'),
                        bootstrap_nginx_snapshot=Path('/tmp/nginx'),
                        bootstrap_compose_sha256='a' * 64,
                        bootstrap_nginx_sha256='b' * 64,
                    )
                adopt.assert_not_called()

    def test_legacy_rollback_adopts_target_only_after_operation_finishes(self) -> None:
        preflight = deploy_release.ProductionPreflight(
            previous_env=b'P2P_IMAGE_TAG=2.0.1-old\n',
            previous_tag='2.0.1-old',
            database_backup=None,
            nginx_snapshot=Path('/rollback/nginx'),
            compose_snapshot=Path('/rollback/compose'),
            expected_image='p2p-transmission:2.0.1-new',
            database_may_have_changed=True,
        )
        operation_state = Path('/tmp/state.json')
        compose_snapshot = Path('/tmp/compose')
        nginx_snapshot = Path('/tmp/nginx')
        with tempfile.TemporaryDirectory() as directory:
            pending = Path(directory) / 'pending.json'
            with (
                patch.object(deploy_release, 'PENDING_RELEASE', pending),
                patch.object(deploy_release, 'load_legacy_operation') as load_operation,
                patch.object(
                    deploy_release,
                    'production_runtime_matches',
                    side_effect=[False, True],
                ),
                patch.object(deploy_release, 'adopt_legacy_pending_release') as adopt,
                patch.object(deploy_release, 'load_pending_release', return_value=preflight),
                patch.object(
                    deploy_release,
                    'running_production_release_matches',
                    return_value=False,
                ),
                patch.object(deploy_release, 'rollback_runtime') as rollback,
                patch.object(deploy_release, 'close_pending_release') as close,
            ):
                deploy_release.rollback_pending_release(
                    '2.0.1-new',
                    bootstrap_previous_version='2.0.1-old',
                    bootstrap_operation_state=operation_state,
                    bootstrap_compose_snapshot=compose_snapshot,
                    bootstrap_nginx_snapshot=nginx_snapshot,
                    bootstrap_compose_sha256='a' * 64,
                    bootstrap_nginx_sha256='b' * 64,
                )
                load_operation.assert_called_once_with(operation_state, '2.0.1-new')
                adopt.assert_called_once_with(
                    '2.0.1-new',
                    '2.0.1-old',
                    operation_state,
                    compose_snapshot,
                    nginx_snapshot,
                    'a' * 64,
                    'b' * 64,
                )
                rollback.assert_called_once_with(preflight)
                close.assert_called_once_with(preflight)

    def test_successful_switch_records_pending_state_without_cleaning_snapshots(self) -> None:
        preflight = deploy_release.ProductionPreflight(
            previous_env=b'P2P_IMAGE_TAG=2.0.1-old\n',
            previous_tag='2.0.1-old',
            database_backup=None,
            nginx_snapshot=Path('/rollback/nginx'),
            compose_snapshot=Path('/rollback/compose'),
            expected_image='p2p-transmission:2.0.1-new',
        )
        events: list[str] = []
        with (
            patch.object(
                deploy_release,
                'prepare_production_environment',
                side_effect=lambda *_: events.append('prepare'),
            ),
            patch.object(deploy_release, 'run'),
            patch.object(deploy_release, 'wait_for_production_ready'),
            patch.object(deploy_release, 'install_production_nginx'),
            patch.object(
                deploy_release,
                'write_pending_release',
                side_effect=lambda *_: events.append('pending'),
            ) as write_pending,
            patch.object(
                deploy_release,
                'mark_pending_database_may_have_changed',
                side_effect=lambda *_: events.append('runtime-boundary'),
            ) as mark_runtime_boundary,
            patch.object(deploy_release, 'cleanup_snapshot_paths') as cleanup,
        ):
            deploy_release.deploy_production(preflight, '2.0.1-new')
            write_pending.assert_called_once_with(preflight, '2.0.1-new')
            mark_runtime_boundary.assert_called_once_with('2.0.1-new')
            self.assertEqual(events, ['pending', 'prepare', 'runtime-boundary'])
            cleanup.assert_not_called()

    def test_pending_state_write_failure_leaves_container_and_database_untouched(self) -> None:
        preflight = deploy_release.ProductionPreflight(
            previous_env=b'P2P_IMAGE_TAG=2.0.1-old\n',
            previous_tag='2.0.1-old',
            database_backup=None,
            nginx_snapshot=Path('/rollback/nginx'),
            compose_snapshot=Path('/rollback/compose'),
            expected_image='p2p-transmission:2.0.1-new',
        )
        with (
            patch.object(deploy_release, 'prepare_production_environment'),
            patch.object(deploy_release, 'run'),
            patch.object(deploy_release, 'wait_for_production_ready'),
            patch.object(deploy_release, 'install_production_nginx'),
            patch.object(
                deploy_release,
                'write_pending_release',
                side_effect=OSError('state unavailable'),
            ),
            patch.object(deploy_release, 'restore_pre_runtime_state') as restore_files,
            patch.object(deploy_release, 'rollback_runtime') as rollback,
            patch.object(deploy_release, 'cleanup_snapshot_paths', return_value=True) as cleanup,
            patch.object(deploy_release, 'PENDING_RELEASE', Path('/missing/pending.json')),
        ):
            with self.assertRaises(OSError):
                deploy_release.deploy_production(preflight, '2.0.1-new')
            restore_files.assert_called_once_with(preflight)
            rollback.assert_not_called()
            cleanup.assert_called_once_with(preflight.nginx_snapshot, preflight.compose_snapshot)

    def test_pending_runtime_boundary_is_durable_and_phase_bound(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rollback_root = root / 'deploy/production/rollback'
            rollback_root.mkdir(parents=True)
            nginx_snapshot = rollback_root / 'p2p-transmission-nginx-test'
            compose_snapshot = rollback_root / 'p2p-transmission-compose-test'
            nginx_snapshot.touch()
            compose_snapshot.touch()
            preflight = deploy_release.ProductionPreflight(
                previous_env=b'P2P_IMAGE_TAG=2.0.1-old\n',
                previous_tag='2.0.1-old',
                database_backup=None,
                nginx_snapshot=nginx_snapshot,
                compose_snapshot=compose_snapshot,
                expected_image='p2p-transmission:2.0.1-new',
            )
            with (
                patch.object(deploy_release, 'APP_DIR', root),
                patch.object(deploy_release, 'PRODUCTION_ROLLBACK', rollback_root),
                patch.object(deploy_release, 'PENDING_RELEASE', rollback_root / 'pending.json'),
            ):
                deploy_release.write_pending_release(preflight, '2.0.1-new')
                updated = deploy_release.mark_pending_database_may_have_changed('2.0.1-new')
                loaded = deploy_release.load_pending_release('2.0.1-new')
                rolled_back = deploy_release.mark_pending_rollback_database_restored(
                    '2.0.1-new'
                )

            self.assertTrue(updated.database_may_have_changed)
            self.assertTrue(loaded.database_may_have_changed)
            self.assertFalse(loaded.rollback_database_restored)
            self.assertTrue(rolled_back.rollback_database_restored)

    def test_recorded_runtime_phase_avoids_replaying_backup_when_old_container_remains(self) -> None:
        preflight = deploy_release.ProductionPreflight(
            previous_env=b'P2P_IMAGE_TAG=2.0.1-old\n',
            previous_tag='2.0.1-old',
            database_backup=Path('/rollback/backup.sqlite3'),
            nginx_snapshot=Path('/rollback/nginx'),
            compose_snapshot=Path('/rollback/compose'),
            expected_image='p2p-transmission:2.0.1-new',
            database_may_have_changed=True,
        )
        with (
            patch.object(
                deploy_release,
                'running_production_release_matches',
                return_value=True,
            ),
            patch.object(deploy_release, 'restore_pre_runtime_state') as restore_files,
            patch.object(deploy_release, 'rollback_runtime') as rollback,
        ):
            deploy_release.rollback_recorded_release(preflight)

        restore_files.assert_called_once_with(preflight)
        rollback.assert_not_called()

    def test_completed_database_rollback_is_never_replayed_when_health_is_unavailable(self) -> None:
        preflight = deploy_release.ProductionPreflight(
            previous_env=b'P2P_IMAGE_TAG=2.0.1-old\n',
            previous_tag='2.0.1-old',
            database_backup=Path('/rollback/backup.sqlite3'),
            nginx_snapshot=Path('/rollback/nginx'),
            compose_snapshot=Path('/rollback/compose'),
            expected_image='p2p-transmission:2.0.1-new',
            database_may_have_changed=True,
            rollback_database_restored=True,
        )
        with (
            patch.object(
                deploy_release,
                'running_production_release_matches',
                return_value=False,
            ),
            patch.object(deploy_release, 'restore_production_environment'),
            patch.object(deploy_release, 'restore_compose', return_value=True),
            patch.object(deploy_release, 'restore_nginx', return_value=True),
            patch.object(deploy_release, 'best_effort', return_value=True) as best_effort,
            patch.object(deploy_release, 'restore_production_database') as restore_database,
            patch.object(deploy_release, 'mark_pending_rollback_database_restored') as mark,
            patch.object(deploy_release, 'wait_for_readiness', return_value=True),
        ):
            deploy_release.rollback_recorded_release(preflight)

        self.assertEqual(best_effort.call_count, 3)
        restore_database.assert_not_called()
        mark.assert_not_called()

    def test_production_workflow_rolls_back_failed_public_verification(self) -> None:
        workflow = PRODUCTION_WORKFLOW.read_text(encoding='utf-8')
        verification = workflow.index('id: public_verify')
        finalization = workflow.index('Finalize the publicly verified release')
        rollback = workflow.index('Roll back any staged release that was not finalized')
        self.assertLess(verification, finalization)
        self.assertLess(finalization, rollback)
        self.assertIn("steps.finalize.outcome != 'success'", workflow)
        self.assertIn("steps.stage.outcome != 'skipped'", workflow)
        self.assertNotIn("steps.stage.outcome == 'success'", workflow)
        self.assertIn('p2p-transmission-deploy finalize --version', workflow)
        self.assertIn('p2p-transmission-deploy rollback --version', workflow)
        self.assertIn('legacy-deploy-bridge.py', workflow)
        self.assertIn('adopt-legacy --version', workflow)
        self.assertIn('bootstrap-operation-state', workflow)
        self.assertIn('start --operation-id', workflow)
        self.assertIn('wait --operation-id', workflow)
        self.assertIn('--mode $HELPER_MODE', workflow)
        self.assertIn('Prepare the disconnect-safe deployment supervisor', workflow)
        self.assertIn('sudo -n /usr/local/sbin/p2p-transmission-deploy', workflow)
        self.assertNotIn('p2p-transmission-deploy stage --archive', workflow)
        self.assertIn('p2p-transmission-deploy protocol-version', workflow)
        self.assertNotIn('p2p-transmission-deploy stage --help', workflow)
        self.assertNotIn('p2p-transmission-deploy rollback --help', workflow)
        self.assertNotIn('sudo /usr/bin/python3 /tmp/', workflow)
        self.assertIn('deploy/scripts/verify-public-release.py', workflow)
        self.assertNotIn('/app?intent=create', workflow)
        cleanup = workflow.index('Remove temporary remote release artifacts')
        ssh_cleanup = workflow.index('Remove temporary SSH material')
        cleanup_block = workflow[cleanup:ssh_cleanup]
        self.assertIn("steps.finalize.outcome == 'success'", cleanup_block)
        self.assertIn("steps.rollback.outcome == 'success'", cleanup_block)
        self.assertIn('cleanup --operation-id', cleanup_block)
        self.assertIn('--version $RELEASE_VERSION --mode $HELPER_MODE', cleanup_block)
        self.assertNotIn('continue-on-error', cleanup_block)
        self.assertIn('Report preserved recovery artifacts', cleanup_block)
        self.assertIn("steps.cleanup.outcome != 'success'", cleanup_block)
        self.assertIn('operation.json', cleanup_block)
        supervisor = workflow.index('Prepare the disconnect-safe deployment supervisor')
        legacy_baseline = workflow.index('Prepare the one-time legacy helper migration')
        supervisor_block = workflow[supervisor:legacy_baseline]
        self.assertLess(supervisor, legacy_baseline)
        self.assertNotIn("mode == 'legacy'", supervisor_block)
        rollback_block = workflow[rollback:cleanup]
        self.assertIn('[[ "$BRIDGE_STATUS" == "25" ]]', rollback_block)
        self.assertIn(
            '[[ "$BRIDGE_STATUS" != "0" && "$BRIDGE_STATUS" != "23" ]]',
            rollback_block,
        )
        self.assertLess(
            rollback_block.index('wait --operation-id'),
            rollback_block.index('if [[ "$HELPER_MODE" == "legacy" ]]'),
        )
        for marker in (
            '"python3 /tmp/$BRIDGE start --operation-id',
            '"sudo -n /usr/local/sbin/p2p-transmission-deploy adopt-legacy',
            '"sudo -n /usr/local/sbin/p2p-transmission-deploy finalize',
            '"sudo -n /usr/local/sbin/p2p-transmission-deploy rollback',
        ):
            command = workflow.index(marker)
            self.assertIn('ServerAliveCountMax=2', workflow[max(0, command - 300):command])

    def test_creates_verified_database_backup_and_prunes_old_copies(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original_values = (
                deploy_release.APP_DIR,
                deploy_release.PRODUCTION_DATA,
                deploy_release.PRODUCTION_DATABASE,
                deploy_release.PRODUCTION_BACKUPS,
            )
            deploy_release.APP_DIR = root
            deploy_release.PRODUCTION_DATA = root / 'deploy/production/data'
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
                    deploy_release.PRODUCTION_DATA,
                    deploy_release.PRODUCTION_DATABASE,
                    deploy_release.PRODUCTION_BACKUPS,
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
                deploy_release.APP_DIR,
                deploy_release.PRODUCTION_DATA,
                deploy_release.PRODUCTION_DATABASE,
                deploy_release.PRODUCTION_BACKUPS,
            )
            deploy_release.APP_DIR = root
            deploy_release.PRODUCTION_DATA = production_data
            deploy_release.PRODUCTION_DATABASE = production_database
            deploy_release.PRODUCTION_BACKUPS = backups
            try:
                with self.assertRaises(SystemExit):
                    deploy_release.backup_production_database('2.0.1-test')
                self.assertFalse((outside_production / 'backups').exists())
            finally:
                (
                    deploy_release.APP_DIR,
                    deploy_release.PRODUCTION_DATA,
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
