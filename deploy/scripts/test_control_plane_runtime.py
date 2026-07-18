from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy_control_plane import common
from deploy_control_plane import release_state
from deploy_control_plane import runtime


INTERNAL_METRICS = {name: 0 for name in common.REQUIRED_INTERNAL_METRICS}


class ControlPlaneRuntimeTests(unittest.TestCase):
    def test_parses_env_without_exposing_comments(self) -> None:
        values = common.parse_env_text(
            '# comment\nP2P_TURN_URLS=turn:example.test\nP2P_TURN_SECRET="secret-value"\n'
        )
        self.assertEqual(values['P2P_TURN_URLS'], 'turn:example.test')
        self.assertEqual(values['P2P_TURN_SECRET'], 'secret-value')

    def test_internal_metrics_parser_requires_every_integer_counter(self) -> None:
        payload = '\n'.join(
            [
                '# Prometheus fixture',
                *(f'{name} {index}' for index, name in enumerate(sorted(INTERNAL_METRICS))),
            ]
        )
        parsed = runtime.parse_internal_metrics(payload)
        self.assertEqual(set(parsed), set(INTERNAL_METRICS))

        with self.assertRaisesRegex(SystemExit, 'metrics are missing'):
            runtime.parse_internal_metrics('p2p_http_requests_total 1\n')
        duplicated = payload + '\np2p_http_requests_total 2\n'
        with self.assertRaisesRegex(SystemExit, 'invalid or duplicated'):
            runtime.parse_internal_metrics(duplicated)

    def test_builds_production_env_from_existing_turn_settings(self) -> None:
        values = runtime.build_production_env(
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
        values = runtime.build_production_env(
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
            common.format_env({'P2P_TURN_SECRET': 'secret\ninjected=true'})

    def test_readiness_requires_the_exact_release(self) -> None:
        payload = {
            'status': 'ready',
            'service': 'p2p-server',
            'version': '2.0.1',
            'release': '2.0.1-abcdef0',
        }
        self.assertTrue(runtime.readiness_matches(payload, '2.0.1-abcdef0'))
        self.assertFalse(runtime.readiness_matches(payload, '2.0.1-abcdef1'))
        self.assertFalse(
            runtime.readiness_matches({**payload, 'release': ''}, '2.0.1-abcdef0')
        )
        unversioned = {key: value for key, value in payload.items() if key != 'release'}
        self.assertFalse(runtime.readiness_matches(unversioned, '2.0.1-abcdef0'))

    def test_deployment_requires_the_previous_rollback_image(self) -> None:
        with patch.object(runtime, 'image_exists', return_value=True):
            self.assertEqual(
                runtime.require_rollback_image('2.0.1-abcdef0'),
                'p2p-transmission:2.0.1-abcdef0',
            )
        with patch.object(runtime, 'image_exists', return_value=False):
            with self.assertRaises(SystemExit):
                runtime.require_rollback_image('2.0.1-missing')
        with self.assertRaises(SystemExit):
            runtime.require_rollback_image(None)

    def test_invalid_environment_is_not_replaced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            production_env = root / 'deploy/production/.env'
            production_data = root / 'deploy/production/data'
            production_env.parent.mkdir(parents=True)
            original = b'P2P_IMAGE_TAG=2.0.1-abcdef0\n'
            production_env.write_bytes(original)

            original_values = (
                runtime.PRODUCTION_ENV,
                runtime.PRODUCTION_DATA,
            )
            runtime.PRODUCTION_ENV = production_env
            runtime.PRODUCTION_DATA = production_data
            try:
                with self.assertRaises(SystemExit):
                    runtime.prepare_production_environment('2.0.1-abcdef1', original)
                self.assertEqual(production_env.read_bytes(), original)
                self.assertFalse(production_data.exists())
            finally:
                (
                    runtime.PRODUCTION_ENV,
                    runtime.PRODUCTION_DATA,
                ) = original_values

    def test_rollback_requires_every_asset_and_old_runtime_readiness(self) -> None:
        preflight = release_state.ProductionPreflight(
            previous_env=b'P2P_IMAGE_TAG=old\n',
            previous_tag='2.0.1-abcdef0',
            database_backup=None,
            nginx_snapshot=Path('/run/nginx-snapshot'),
            compose_snapshot=Path('/run/compose-snapshot'),
            expected_image='p2p-transmission:2.0.1-new',
        )
        with (
            patch.object(runtime, 'best_effort', return_value=True) as best_effort,
            patch.object(runtime, 'restore_production_database', return_value=True),
            patch.object(runtime, 'restore_nginx', return_value=True),
            patch.object(runtime, 'restore_compose', return_value=True),
            patch.object(runtime, 'restore_production_environment'),
            patch.object(runtime, 'mark_pending_rollback_database_restored') as marked,
            patch.object(runtime, 'wait_for_readiness', return_value=True) as ready,
        ):
            runtime.rollback_runtime(preflight)
            self.assertEqual(best_effort.call_count, 3)
            marked.assert_called_once_with('2.0.1-new')
            ready.assert_called_once_with('2.0.1-abcdef0')

        with (
            patch.object(runtime, 'best_effort', return_value=True) as best_effort,
            patch.object(runtime, 'restore_production_database', return_value=False),
            patch.object(runtime, 'restore_nginx', return_value=True),
            patch.object(runtime, 'restore_compose', return_value=True),
            patch.object(runtime, 'restore_production_environment'),
            patch.object(runtime, 'mark_pending_rollback_database_restored') as marked,
            patch.object(runtime, 'wait_for_readiness') as ready,
        ):
            with self.assertRaises(SystemExit):
                runtime.rollback_runtime(preflight)
            self.assertEqual(best_effort.call_count, 2)
            marked.assert_not_called()
            ready.assert_not_called()

        with (
            patch.object(runtime, 'best_effort') as best_effort,
            patch.object(runtime, 'restore_production_database') as restore_database,
            patch.object(runtime, 'restore_nginx', return_value=False),
            patch.object(runtime, 'restore_compose', return_value=True),
            patch.object(runtime, 'restore_production_environment'),
            patch.object(runtime, 'mark_pending_rollback_database_restored') as marked,
            patch.object(runtime, 'wait_for_readiness') as ready,
        ):
            with self.assertRaises(SystemExit):
                runtime.rollback_runtime(preflight)
            best_effort.assert_not_called()
            marked.assert_not_called()
            restore_database.assert_not_called()
            ready.assert_not_called()

    def test_staged_release_retains_rollback_state_until_finalize(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rollback_root = root / 'deploy/production/rollback'
            rollback_root.mkdir(parents=True)
            nginx_snapshot = rollback_root / 'p2p-transmission-nginx-test'
            compose_snapshot = rollback_root / 'p2p-transmission-compose-test'
            nginx_snapshot.write_text('old nginx', encoding='utf-8')
            compose_snapshot.write_text('old compose', encoding='utf-8')
            preflight = release_state.ProductionPreflight(
                previous_env=b'P2P_IMAGE_TAG=2.0.1-old\n',
                previous_tag='2.0.1-old',
                database_backup=None,
                nginx_snapshot=nginx_snapshot,
                compose_snapshot=compose_snapshot,
                expected_image='p2p-transmission:2.0.1-new',
            )
            with (
                patch.object(release_state, 'APP_DIR', root),
                patch.object(release_state, 'PRODUCTION_ROLLBACK', rollback_root),
                patch.object(release_state, 'PENDING_RELEASE', rollback_root / 'pending.json'),
                patch.object(runtime, 'wait_for_production_ready') as ready,
            ):
                release_state.write_pending_release(preflight, '2.0.1-new')
                self.assertTrue(release_state.PENDING_RELEASE.is_file())
                self.assertTrue(nginx_snapshot.is_file())
                self.assertTrue(compose_snapshot.is_file())

                loaded = release_state.load_pending_release('2.0.1-new')
                self.assertEqual(loaded.previous_tag, '2.0.1-old')
                self.assertFalse(loaded.database_may_have_changed)
                self.assertFalse(loaded.rollback_database_restored)
                runtime.finalize_pending_release('2.0.1-new')

                ready.assert_called_once_with('2.0.1-new')
                self.assertFalse(release_state.PENDING_RELEASE.exists())
                self.assertFalse(nginx_snapshot.exists())
                self.assertFalse(compose_snapshot.exists())

    def test_pending_release_can_run_the_existing_automatic_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            rollback_root = root / 'deploy/production/rollback'
            rollback_root.mkdir(parents=True)
            nginx_snapshot = rollback_root / 'p2p-transmission-nginx-test'
            compose_snapshot = rollback_root / 'p2p-transmission-compose-test'
            nginx_snapshot.touch()
            compose_snapshot.touch()
            preflight = release_state.ProductionPreflight(
                previous_env=b'P2P_IMAGE_TAG=2.0.1-old\n',
                previous_tag='2.0.1-old',
                database_backup=None,
                nginx_snapshot=nginx_snapshot,
                compose_snapshot=compose_snapshot,
                expected_image='p2p-transmission:2.0.1-new',
            )
            with (
                patch.object(release_state, 'APP_DIR', root),
                patch.object(release_state, 'PRODUCTION_ROLLBACK', rollback_root),
                patch.object(release_state, 'PENDING_RELEASE', rollback_root / 'pending.json'),
                patch.object(runtime, 'PENDING_RELEASE', rollback_root / 'pending.json'),
                patch.object(runtime, 'restore_pre_runtime_state') as restore_files,
                patch.object(runtime, 'rollback_runtime') as rollback,
            ):
                release_state.write_pending_release(preflight, '2.0.1-new')
                runtime.rollback_pending_release('2.0.1-new')

                restore_files.assert_called_once()
                restored = restore_files.call_args.args[0]
                self.assertEqual(restored.previous_tag, '2.0.1-old')
                rollback.assert_not_called()
                self.assertFalse(release_state.PENDING_RELEASE.exists())
                self.assertFalse(nginx_snapshot.exists())
                self.assertFalse(compose_snapshot.exists())

    def test_rollback_is_a_safe_noop_when_stage_never_created_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            pending = Path(directory) / 'pending.json'
            with patch.object(runtime, 'PENDING_RELEASE', pending):
                runtime.rollback_pending_release('2.0.1-new')

    def test_successful_switch_records_pending_state_without_cleaning_snapshots(self) -> None:
        preflight = release_state.ProductionPreflight(
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
                runtime,
                'prepare_production_environment',
                side_effect=lambda *_: events.append('prepare'),
            ),
            patch.object(runtime, 'run'),
            patch.object(runtime, 'wait_for_production_ready'),
            patch.object(runtime, 'install_production_nginx'),
            patch.object(
                runtime,
                'write_pending_release',
                side_effect=lambda *_: events.append('pending'),
            ) as write_pending,
            patch.object(
                runtime,
                'mark_pending_database_may_have_changed',
                side_effect=lambda *_: events.append('runtime-boundary'),
            ) as mark_runtime_boundary,
            patch.object(release_state, 'cleanup_snapshot_paths') as cleanup,
        ):
            runtime.deploy_production(preflight, '2.0.1-new')
            write_pending.assert_called_once_with(preflight, '2.0.1-new')
            mark_runtime_boundary.assert_called_once_with('2.0.1-new')
            self.assertEqual(events, ['pending', 'prepare', 'runtime-boundary'])
            cleanup.assert_not_called()

    def test_pending_state_write_failure_leaves_container_and_database_untouched(self) -> None:
        preflight = release_state.ProductionPreflight(
            previous_env=b'P2P_IMAGE_TAG=2.0.1-old\n',
            previous_tag='2.0.1-old',
            database_backup=None,
            nginx_snapshot=Path('/rollback/nginx'),
            compose_snapshot=Path('/rollback/compose'),
            expected_image='p2p-transmission:2.0.1-new',
        )
        with (
            patch.object(runtime, 'prepare_production_environment'),
            patch.object(runtime, 'run'),
            patch.object(runtime, 'wait_for_production_ready'),
            patch.object(runtime, 'install_production_nginx'),
            patch.object(
                runtime,
                'write_pending_release',
                side_effect=OSError('state unavailable'),
            ),
            patch.object(runtime, 'restore_pre_runtime_state') as restore_files,
            patch.object(runtime, 'rollback_runtime') as rollback,
            patch.object(release_state, 'cleanup_snapshot_paths', return_value=True) as cleanup,
            patch.object(runtime, 'PENDING_RELEASE', Path('/missing/pending.json')),
        ):
            with self.assertRaises(OSError):
                runtime.deploy_production(preflight, '2.0.1-new')
            restore_files.assert_called_once_with(preflight)
            rollback.assert_not_called()
            cleanup.assert_called_once_with(preflight.nginx_snapshot, preflight.compose_snapshot)

    def test_recorded_runtime_phase_avoids_replaying_backup_when_old_container_remains(self) -> None:
        preflight = release_state.ProductionPreflight(
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
                runtime,
                'running_production_release_matches',
                return_value=True,
            ),
            patch.object(runtime, 'restore_pre_runtime_state') as restore_files,
            patch.object(runtime, 'rollback_runtime') as rollback,
        ):
            runtime.rollback_recorded_release(preflight)

        restore_files.assert_called_once_with(preflight)
        rollback.assert_not_called()

    def test_completed_database_rollback_is_never_replayed_when_health_is_unavailable(self) -> None:
        preflight = release_state.ProductionPreflight(
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
                runtime,
                'running_production_release_matches',
                return_value=False,
            ),
            patch.object(runtime, 'restore_production_environment'),
            patch.object(runtime, 'restore_compose', return_value=True),
            patch.object(runtime, 'restore_nginx', return_value=True),
            patch.object(runtime, 'best_effort', return_value=True) as best_effort,
            patch.object(runtime, 'restore_production_database') as restore_database,
            patch.object(runtime, 'mark_pending_rollback_database_restored') as mark,
            patch.object(runtime, 'wait_for_readiness', return_value=True),
        ):
            runtime.rollback_recorded_release(preflight)

        self.assertEqual(best_effort.call_count, 3)
        restore_database.assert_not_called()
        mark.assert_not_called()


if __name__ == '__main__':
    unittest.main()
