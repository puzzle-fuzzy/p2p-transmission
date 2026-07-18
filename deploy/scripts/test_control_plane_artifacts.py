from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy_control_plane import artifacts
from deploy_control_plane import common
from deploy_control_plane import release_state
from deploy_test_support import REPOSITORY_ROOT, write_tar_fixture


class ControlPlaneArtifactTests(unittest.TestCase):
    def test_source_archive_validation_refuses_every_protected_runtime_prefix(self) -> None:
        protected_paths = (
            '.git/config',
            'deploy/production/.env',
            'deploy/production/data/control.sqlite3',
            'deploy/production/backups/control-old.sqlite3',
            'deploy/production/rollback/pending.json',
            'deploy/production/source-files.json',
            'deploy/coturn/.local/turn.pid',
            'deploy/coturn/turnserver.conf',
            'deploy/coturn/private.key',
            'deploy/.env',
            'deploy/data/control.sqlite',
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'application'
            app.mkdir()
            for index, protected in enumerate(protected_paths):
                with self.subTest(path=protected):
                    archive = root / f'source-{index}.tar.gz'
                    write_tar_fixture(archive, {protected: b'protected'})
                    with (
                        patch.object(artifacts, 'APP_DIR', app),
                        patch.object(
                            artifacts,
                            'validate_tmp_file',
                            return_value=archive,
                        ),
                        self.assertRaisesRegex(SystemExit, 'protected production path'),
                    ):
                        artifacts.validate_source_archive(archive)

    def test_source_archive_validation_keeps_tracked_production_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'application'
            app.mkdir()
            archive = root / 'source.tar.gz'
            write_tar_fixture(
                archive,
                {
                    **{
                        path: (REPOSITORY_ROOT / path).read_bytes()
                        for path in common.TRACKED_RUNTIME_CONFIG_HASHES
                    },
                    'rust/apps/server/src/main.rs': b'fn main() {}\n',
                },
            )
            with (
                patch.object(artifacts, 'APP_DIR', app),
                patch.object(artifacts, 'validate_tmp_file', return_value=archive),
            ):
                self.assertEqual(artifacts.validate_source_archive(archive), archive)

    def test_runtime_configuration_hashes_match_the_tracked_sources(self) -> None:
        for path, expected in common.TRACKED_RUNTIME_CONFIG_HASHES.items():
            with self.subTest(path=path):
                actual = hashlib.sha256((REPOSITORY_ROOT / path).read_bytes()).hexdigest()
                self.assertEqual(actual, expected)

    def test_source_archive_validation_rejects_changed_runtime_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'application'
            app.mkdir()
            archive = root / 'source.tar.gz'
            members = {
                path: (REPOSITORY_ROOT / path).read_bytes()
                for path in common.TRACKED_RUNTIME_CONFIG_HASHES
            }
            members['deploy/production/compose.yml'] = b'services: { attacker: {} }\n'
            write_tar_fixture(archive, members)
            with (
                patch.object(artifacts, 'APP_DIR', app),
                patch.object(artifacts, 'validate_tmp_file', return_value=archive),
                self.assertRaisesRegex(SystemExit, 'runtime configuration is not approved'),
            ):
                artifacts.validate_source_archive(archive)

    def test_source_extraction_never_preserves_uploaded_privilege_bits(self) -> None:
        with patch.object(artifacts, 'run') as run:
            artifacts.extract_archive(Path('/tmp/source.tar.gz'))
        command = run.call_args.args[0]
        self.assertIn('--no-same-owner', command)
        self.assertIn('--no-same-permissions', command)

    def test_release_artifacts_are_bound_to_a_private_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / 'application'
            production = app / 'deploy/production'
            rollback = production / 'rollback'
            production.mkdir(parents=True)
            uploads = root / 'uploads'
            uploads.mkdir()
            commit = 'b' * 40
            source = uploads / f'p2p-transmission-{commit}.tar.gz'
            image = uploads / f'p2p-transmission-image-{commit}.tar.gz'
            source.write_bytes(b'original-source')
            image.write_bytes(b'original-image')
            for path in (source, image):
                path.chmod(0o600)

            with (
                patch.object(release_state, 'APP_DIR', app),
                patch.object(release_state, 'PRODUCTION_ROLLBACK', rollback),
                patch.object(artifacts, 'UPLOAD_ROOT', uploads),
                patch.object(artifacts, 'require_disk_capacity'),
            ):
                snapshot = artifacts.snapshot_release_artifacts(
                    source,
                    image,
                )
                cleanup_count = 0
                try:
                    replacement = uploads / 'replacement.tar.gz'
                    replacement.write_bytes(b'replaced-after-validation')
                    replacement.replace(source)

                    self.assertEqual(snapshot.source_archive.read_bytes(), b'original-source')
                    self.assertEqual(snapshot.image_archive.read_bytes(), b'original-image')
                    self.assertEqual(
                        artifacts.validate_image_archive(
                            snapshot.image_archive,
                            trusted_root=snapshot.root,
                        ),
                        snapshot.image_archive.resolve(),
                    )
                    with self.assertRaisesRegex(SystemExit, 'escaped'):
                        artifacts.validate_image_archive(
                            image,
                            trusted_root=snapshot.root,
                        )
                    self.assertEqual(snapshot.root.parent, rollback.resolve())
                    self.assertNotEqual(snapshot.root.parent, uploads.resolve())
                finally:
                    cleanup_count = release_state.cleanup_abandoned_release_artifacts()
                self.assertEqual(cleanup_count, 1)
                self.assertFalse(snapshot.root.exists())

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

            original_values = (
                artifacts.APP_DIR,
                common.APP_DIR,
                artifacts.SOURCE_MANIFEST,
            )
            artifacts.APP_DIR = root
            common.APP_DIR = root
            artifacts.SOURCE_MANIFEST = root / 'deploy/production/source-files.json'
            artifacts.SOURCE_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
            artifacts.SOURCE_MANIFEST.write_text(
                json.dumps(['deploy/production/.env', 'retired/frontend/client.js']),
                encoding='utf-8',
            )
            artifacts.SOURCE_MANIFEST.chmod(0o600)
            try:
                removed = artifacts.remove_retired_source_files(
                    {'rust/apps/server/src/main.rs'},
                )
                artifacts.write_source_manifest({'rust/apps/server/src/main.rs'})
                self.assertEqual(removed, 1)
                self.assertFalse(old_source.exists())
                self.assertTrue(untracked_cache.is_file())
                self.assertTrue(current_source.is_file())
                self.assertTrue(production_env.is_file())
                self.assertEqual(
                    json.loads(artifacts.SOURCE_MANIFEST.read_text(encoding='utf-8')),
                    ['rust/apps/server/src/main.rs'],
                )
            finally:
                (
                    artifacts.APP_DIR,
                    common.APP_DIR,
                    artifacts.SOURCE_MANIFEST,
                ) = original_values

    def test_source_manifest_is_the_only_retirement_authority(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stale = root / 'retired/service/src/main.rs'
            bootstrap_only = root / 'docs/keep.md'
            for path in (stale, bootstrap_only):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture', encoding='utf-8')

            original_values = (
                artifacts.APP_DIR,
                common.APP_DIR,
                artifacts.SOURCE_MANIFEST,
            )
            artifacts.APP_DIR = root
            common.APP_DIR = root
            artifacts.SOURCE_MANIFEST = root / 'deploy/production/source-files.json'
            artifacts.SOURCE_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
            artifacts.SOURCE_MANIFEST.write_text(
                json.dumps(['retired/service/src/main.rs']),
                encoding='utf-8',
            )
            artifacts.SOURCE_MANIFEST.chmod(0o600)
            try:
                artifacts.remove_retired_source_files(set())
                self.assertFalse(stale.exists())
                self.assertTrue(bootstrap_only.is_file())
            finally:
                (
                    artifacts.APP_DIR,
                    common.APP_DIR,
                    artifacts.SOURCE_MANIFEST,
                ) = original_values

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

            original_values = (
                artifacts.APP_DIR,
                common.APP_DIR,
                artifacts.SOURCE_MANIFEST,
            )
            artifacts.APP_DIR = root
            common.APP_DIR = root
            artifacts.SOURCE_MANIFEST = root / 'deploy/production/source-files.json'
            artifacts.SOURCE_MANIFEST.parent.mkdir(parents=True)
            artifacts.SOURCE_MANIFEST.write_text(
                json.dumps(['linked/victim.txt']),
                encoding='utf-8',
            )
            artifacts.SOURCE_MANIFEST.chmod(0o600)
            try:
                with self.assertRaises(SystemExit):
                    artifacts.remove_retired_source_files(set())
                self.assertEqual(victim.read_text(encoding='utf-8'), 'must survive')
            finally:
                (
                    artifacts.APP_DIR,
                    common.APP_DIR,
                    artifacts.SOURCE_MANIFEST,
                ) = original_values

    def test_retired_source_cleanup_rejects_a_missing_current_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with (
                patch.object(artifacts, 'APP_DIR', root),
                patch.object(
                    artifacts,
                    'SOURCE_MANIFEST',
                    root / 'deploy/production/source-files.json',
                ),
                self.assertRaisesRegex(SystemExit, 'clean bootstrap is required'),
            ):
                artifacts.remove_retired_source_files(set())


if __name__ == '__main__':
    unittest.main()
