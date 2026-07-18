from __future__ import annotations

import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch


SCRIPTS_ROOT = Path(__file__).resolve().parent
if str(SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_ROOT))

from deploy_control_plane import release_state  # noqa: E402


@contextmanager
def rollback_layout(root: Path):
    app = root / 'application'
    rollback = app / 'deploy' / 'production' / 'rollback'
    rollback.mkdir(parents=True)
    rollback.chmod(0o700)
    pending = rollback / 'pending-release.json'
    with (
        patch.object(release_state, 'APP_DIR', app),
        patch.object(release_state, 'PRODUCTION_ROLLBACK', rollback),
        patch.object(release_state, 'PENDING_RELEASE', pending),
    ):
        yield rollback, pending


def preflight(nginx: Path, compose: Path) -> release_state.ProductionPreflight:
    return release_state.ProductionPreflight(
        previous_env=b'P2P_IMAGE_TAG=2.0.1-old\n',
        previous_tag='2.0.1-old',
        database_backup=None,
        nginx_snapshot=nginx,
        compose_snapshot=compose,
        expected_image='p2p-transmission:2.0.1-new',
    )


class ReleaseStateCleanupTests(unittest.TestCase):
    def test_removes_only_unreferenced_runtime_snapshots(self) -> None:
        with tempfile.TemporaryDirectory() as directory, rollback_layout(
            Path(directory)
        ) as (rollback, _):
            nginx = rollback / f'{release_state.NGINX_SNAPSHOT_PREFIX}orphan'
            compose = rollback / f'{release_state.COMPOSE_SNAPSHOT_PREFIX}orphan'
            unrelated = rollback / 'operator-note'
            for path in (nginx, compose, unrelated):
                path.write_bytes(b'fixture')
                path.chmod(0o600)

            self.assertEqual(release_state.cleanup_abandoned_runtime_snapshots(), 2)
            self.assertFalse(nginx.exists())
            self.assertFalse(compose.exists())
            self.assertTrue(unrelated.exists())

    def test_preserves_snapshots_referenced_by_pending_release(self) -> None:
        with tempfile.TemporaryDirectory() as directory, rollback_layout(
            Path(directory)
        ) as (rollback, _):
            nginx = rollback / f'{release_state.NGINX_SNAPSHOT_PREFIX}active'
            compose = rollback / f'{release_state.COMPOSE_SNAPSHOT_PREFIX}active'
            orphan = rollback / f'{release_state.NGINX_SNAPSHOT_PREFIX}orphan'
            for path in (nginx, compose, orphan):
                path.write_bytes(b'fixture')
                path.chmod(0o600)
            release_state.write_pending_release(preflight(nginx, compose), '2.0.1-new')

            self.assertEqual(release_state.cleanup_abandoned_runtime_snapshots(), 1)
            self.assertTrue(nginx.exists())
            self.assertTrue(compose.exists())
            self.assertFalse(orphan.exists())

    def test_close_pending_release_reports_snapshot_cleanup_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory, rollback_layout(
            Path(directory)
        ) as (rollback, pending):
            nginx = rollback / f'{release_state.NGINX_SNAPSHOT_PREFIX}active'
            compose = rollback / f'{release_state.COMPOSE_SNAPSHOT_PREFIX}active'
            for path in (nginx, compose):
                path.write_bytes(b'fixture')
                path.chmod(0o600)
            state = preflight(nginx, compose)
            release_state.write_pending_release(state, '2.0.1-new')

            with (
                patch.object(
                    release_state.ProductionPreflight,
                    'cleanup_snapshots',
                    return_value=False,
                ),
                self.assertRaisesRegex(SystemExit, 'snapshot cleanup failed'),
            ):
                release_state.close_pending_release(state)
            self.assertFalse(pending.exists())


if __name__ == '__main__':
    unittest.main()
