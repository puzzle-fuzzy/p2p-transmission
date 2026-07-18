from __future__ import annotations

import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch


SCRIPTS_ROOT = Path(__file__).resolve().parent
if str(SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_ROOT))

from deploy_control_plane import cli  # noqa: E402


class ControlPlaneCliBindingTests(unittest.TestCase):
    def test_stage_binds_expected_digest_inside_lock_before_cleanup(self) -> None:
        events: list[str] = []

        @contextmanager
        def locked():
            events.append('lock-enter')
            try:
                yield
            finally:
                events.append('lock-exit')

        digest = 'a' * 64
        arguments = [
            'deploy-release.py',
            'stage',
            '--archive',
            '/tmp/p2p-transmission-' + 'b' * 40 + '.tar.gz',
            '--image-archive',
            '/tmp/p2p-transmission-image-' + 'b' * 40 + '.tar.gz',
            '--version',
            '2.0.1-test',
            '--expected-control-plane-sha256',
            digest,
        ]
        with (
            patch.object(cli.sys, 'argv', arguments),
            patch.object(
                cli.release_state,
                'production_control_plane_lock',
                side_effect=locked,
            ),
            patch.object(
                cli,
                'validate_running_control_plane',
                side_effect=lambda value: events.append(f'validate:{value}'),
            ),
            patch.object(
                cli.release_state,
                'cleanup_abandoned_release_artifacts',
                side_effect=lambda: events.append('cleanup-artifacts'),
            ),
            patch.object(
                cli.release_state,
                'cleanup_abandoned_runtime_snapshots',
                side_effect=lambda: events.append('cleanup-snapshots'),
            ),
            patch.object(cli, 'deploy', side_effect=lambda *_: events.append('deploy')),
        ):
            self.assertEqual(cli.main(), 0)

        self.assertEqual(
            events,
            [
                'lock-enter',
                f'validate:{digest}',
                'cleanup-artifacts',
                'cleanup-snapshots',
                'deploy',
                'lock-exit',
            ],
        )

    def test_finalize_binds_the_current_imported_version(self) -> None:
        digest = 'c' * 64
        events: list[str] = []

        @contextmanager
        def locked():
            yield

        with (
            patch.object(
                cli.sys,
                'argv',
                ['deploy-release.py', 'finalize', '--version', '2.0.1-test'],
            ),
            patch.object(
                cli.release_state,
                'production_control_plane_lock',
                side_effect=locked,
            ),
            patch.object(cli, 'imported_control_plane_sha256', return_value=digest),
            patch.object(
                cli,
                'validate_running_control_plane',
                side_effect=lambda value: events.append(f'validate:{value}'),
            ),
            patch.object(cli.release_state, 'cleanup_abandoned_release_artifacts'),
            patch.object(cli.release_state, 'cleanup_abandoned_runtime_snapshots'),
            patch.object(
                cli.runtime,
                'finalize_pending_release',
                side_effect=lambda version: events.append(f'finalize:{version}'),
            ),
        ):
            self.assertEqual(cli.main(), 0)

        self.assertEqual(events, [f'validate:{digest}', 'finalize:2.0.1-test'])


if __name__ == '__main__':
    unittest.main()
