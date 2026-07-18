from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy_control_plane import common
from deploy_control_plane import release_state


class ControlPlaneReleaseStateTests(unittest.TestCase):
    def test_abandoned_release_artifact_cleanup_fails_closed_on_unsafe_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'application'
            production = app / 'deploy/production'
            rollback = production / 'rollback'
            production.mkdir(parents=True)
            unsafe = rollback / f'{common.ARTIFACT_SNAPSHOT_PREFIX}unsafe'
            nested = unsafe / 'nested-directory'
            rollback.mkdir()
            rollback.chmod(0o700)
            unsafe.mkdir()
            unsafe.chmod(0o700)
            nested.mkdir()

            with (
                patch.object(release_state, 'APP_DIR', app),
                patch.object(release_state, 'PRODUCTION_ROLLBACK', rollback),
                self.assertRaisesRegex(SystemExit, 'artifact is unsafe'),
            ):
                release_state.cleanup_abandoned_release_artifacts()
            self.assertTrue(nested.is_dir())

    def test_snapshot_cleanup_is_best_effort(self) -> None:
        preflight = release_state.ProductionPreflight(
            previous_env=b'',
            previous_tag='2.0.1-abcdef0',
            database_backup=None,
            nginx_snapshot=Path('/run/nginx-snapshot'),
            compose_snapshot=Path('/run/compose-snapshot'),
            expected_image='p2p-transmission:2.0.1-new',
        )
        with patch.object(Path, 'unlink', side_effect=[OSError('busy'), None]):
            self.assertFalse(preflight.cleanup_snapshots())

    def test_pending_release_rejects_a_different_version(self) -> None:
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
            ):
                release_state.write_pending_release(preflight, '2.0.1-new')
                with self.assertRaises(SystemExit):
                    release_state.load_pending_release('2.0.1-other')
                with self.assertRaises(SystemExit):
                    release_state.ensure_no_pending_release()

    def test_pending_runtime_boundary_is_durable_and_phase_bound(self) -> None:
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
            ):
                release_state.write_pending_release(preflight, '2.0.1-new')
                updated = release_state.mark_pending_database_may_have_changed('2.0.1-new')
                loaded = release_state.load_pending_release('2.0.1-new')
                rolled_back = release_state.mark_pending_rollback_database_restored(
                    '2.0.1-new'
                )

            self.assertTrue(updated.database_may_have_changed)
            self.assertTrue(loaded.database_may_have_changed)
            self.assertFalse(loaded.rollback_database_restored)
            self.assertTrue(rolled_back.rollback_database_restored)


if __name__ == '__main__':
    unittest.main()
