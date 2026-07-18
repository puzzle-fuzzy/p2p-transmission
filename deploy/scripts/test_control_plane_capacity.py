from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from deploy_control_plane import artifacts
from deploy_control_plane import capacity
from deploy_control_plane import cli
from deploy_control_plane import release_state
from deploy_control_plane import runtime
from deploy_test_support import write_tar_fixture


class ControlPlaneCapacityTests(unittest.TestCase):
    def test_archive_working_bytes_uses_the_expanded_payload_peak(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'source.tar.gz'
            payload = b'a' * 4096
            write_tar_fixture(archive, {'rust/apps/server/src/main.rs': payload})
            self.assertEqual(
                capacity.archive_working_bytes(archive, 'source archive'),
                len(payload),
            )

    def test_disk_capacity_groups_demands_by_device_and_keeps_one_margin_each(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            production = root / 'production'
            docker = root / 'docker'
            production.mkdir()
            docker.mkdir()
            demands = [
                capacity.DiskDemand('source', production, 100),
                capacity.DiskDemand('database', production, 50),
                capacity.DiskDemand('image', docker, 200),
            ]

            def device(path: Path) -> int:
                return 2 if path == docker.resolve() else 1

            def usage(path: Path) -> SimpleNamespace:
                free = 210 if path == docker.resolve() else 160
                return SimpleNamespace(free=free)

            with (
                patch.object(capacity, 'filesystem_device', side_effect=device),
                patch.object(shutil, 'disk_usage', side_effect=usage),
            ):
                capacities = capacity.require_disk_capacity(demands, safety_bytes=10)

            by_labels = {
                disk_capacity.labels: disk_capacity for disk_capacity in capacities
            }
            self.assertEqual(by_labels[('database', 'source')].required_bytes, 160)
            self.assertEqual(by_labels[('image',)].required_bytes, 210)

    def test_disk_capacity_sums_same_device_stage_peak_before_accepting(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            demands = [
                capacity.DiskDemand('source', root, 100),
                capacity.DiskDemand('database backup', root, 200),
                capacity.DiskDemand('image', root, 300),
            ]
            with (
                patch.object(capacity, 'filesystem_device', return_value=1),
                patch.object(
                    shutil,
                    'disk_usage',
                    return_value=SimpleNamespace(free=609),
                ),
                self.assertRaisesRegex(SystemExit, '610 bytes required'),
            ):
                capacity.require_disk_capacity(demands, safety_bytes=10)

    def test_stage_disk_demands_charge_archives_backup_restore_and_docker_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'application'
            data = app / 'deploy/production/data'
            backups = app / 'deploy/production/backups'
            docker = root / 'docker'
            for path in (data, backups, docker):
                path.mkdir(parents=True)
            source = root / 'source.tar.gz'
            image = root / 'image.tar.gz'
            source.touch()
            image.touch()
            with (
                patch.object(capacity, 'APP_DIR', app),
                patch.object(capacity, 'PRODUCTION_DATA', data),
                patch.object(capacity, 'PRODUCTION_BACKUPS', backups),
                patch.object(
                    capacity,
                    'archive_working_bytes',
                    side_effect=[123, 456],
                ),
                patch.object(
                    capacity,
                    'production_database_working_bytes',
                    return_value=789,
                ),
            ):
                demands = capacity.stage_disk_demands(source, image, docker)

            by_label = {demand.label: demand for demand in demands}
            self.assertEqual(by_label['source archive extraction'].working_bytes, 123)
            self.assertEqual(by_label['database backup'].working_bytes, 789)
            self.assertEqual(by_label['database rollback restore'].working_bytes, 789)
            self.assertEqual(by_label['Docker image load'].working_bytes, 456)
            self.assertEqual(by_label['Docker image load'].path, docker)

    def test_stage_refuses_low_disk_before_preflight_and_cleans_uploaded_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            uploads = root / 'uploads'
            uploads.mkdir()
            commit = 'a' * 40
            source = uploads / f'p2p-transmission-{commit}.tar.gz'
            image = uploads / f'p2p-transmission-image-{commit}.tar.gz'
            for path in (source, image):
                path.touch()
            private_root = root / 'private-artifacts'
            private_root.mkdir()
            private_source = private_root / source.name
            private_image = private_root / image.name
            for path in (private_source, private_image):
                path.touch()
            snapshot = artifacts.ReleaseArtifactSnapshot(
                root=private_root,
                source_archive=private_source,
                image_archive=private_image,
            )
            with (
                patch.object(artifacts, 'UPLOAD_ROOT', uploads),
                patch.object(release_state, 'ensure_no_pending_release'),
                patch.object(
                    artifacts,
                    'snapshot_release_artifacts',
                    return_value=snapshot,
                ),
                patch.object(
                    artifacts,
                    'validate_source_archive',
                    return_value=private_source,
                ),
                patch.object(
                    artifacts,
                    'validate_image_archive',
                    return_value=private_image,
                ),
                patch.object(artifacts, 'source_archive_files', return_value=set()),
                patch.object(artifacts, 'read_source_manifest', return_value=set()),
                patch.object(
                    capacity,
                    'require_stage_disk_capacity',
                    side_effect=SystemExit('insufficient disk space'),
                ) as require_capacity,
                patch.object(runtime, 'preflight_production') as preflight,
                self.assertRaisesRegex(SystemExit, 'insufficient disk space'),
            ):
                cli.deploy(source, '2.0.1-test', image)

            require_capacity.assert_called_once_with(private_source, private_image)
            preflight.assert_not_called()
            self.assertFalse(source.exists())
            self.assertFalse(image.exists())
            self.assertFalse(private_root.exists())

    def test_docker_root_discovery_requires_valid_json_absolute_existing_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            docker = Path(directory)
            with patch.object(
                subprocess,
                'run',
                return_value=SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps(str(docker)),
                ),
            ):
                self.assertEqual(capacity.discover_docker_root(), docker.resolve())
            with patch.object(
                subprocess,
                'run',
                return_value=SimpleNamespace(returncode=0, stdout='"relative/docker"'),
            ):
                self.assertIsNone(capacity.discover_docker_root())

    def test_maintenance_disk_demands_count_create_and_restore_peak(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backups = root / 'deploy/production/backups'
            backups.mkdir(parents=True)
            recent = backups / 'control-recent.sqlite3'
            recent.write_bytes(b'x' * 57)
            with (
                patch.object(capacity, 'PRODUCTION_BACKUPS', backups),
                patch.object(
                    capacity,
                    'production_database_working_bytes',
                    return_value=123,
                ),
            ):
                creating = capacity.maintenance_disk_demands(
                    None,
                    create_backup=True,
                )
                reusing = capacity.maintenance_disk_demands(
                    recent,
                    create_backup=False,
                )

            self.assertEqual(sum(item.working_bytes for item in creating), 246)
            self.assertEqual(
                {item.label for item in creating},
                {'database backup', 'database restore drill'},
            )
            self.assertEqual(reusing[0].working_bytes, 57)


if __name__ == '__main__':
    unittest.main()
