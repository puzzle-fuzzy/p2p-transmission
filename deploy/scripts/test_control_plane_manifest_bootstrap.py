from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy_control_plane import cli
from deploy_control_plane import manifest
from deploy_test_support import (
    BOOTSTRAP_HOST,
    CONTROL_PLANE_CLI,
    DEPLOY_SUDOERS,
    DEPLOY_WRAPPER,
    MODULE_PATH,
)


class ControlPlaneManifestBootstrapTests(unittest.TestCase):
    def test_control_plane_status_requires_the_fixed_exact_helper(self) -> None:
        expected = cli.source_control_plane_manifest(MODULE_PATH.parent)
        bundle_manifest = manifest.control_plane_manifest(MODULE_PATH.parent)
        with patch.object(
            manifest,
            'validate_installed_control_plane',
            return_value=(expected, bundle_manifest),
        ) as validate:
            cli.report_control_plane_status(
                expected,
                running_helper=MODULE_PATH,
                configured_helper=MODULE_PATH,
            )
        validate.assert_called_once_with(
            MODULE_PATH,
            MODULE_PATH,
            Path(cli.__file__).resolve(strict=True).parent,
            expected,
        )

    def test_control_plane_manifest_covers_and_hashes_every_module(self) -> None:
        source_root = MODULE_PATH.parent
        expected_files = {
            'deploy-release.py',
            *(f'deploy_control_plane/{name}' for name in manifest.MANAGED_MODULES),
        }
        bundle_manifest = manifest.control_plane_manifest(source_root)
        self.assertEqual(
            {entry['path'] for entry in bundle_manifest['files']},
            expected_files,
        )
        source_digest = manifest.control_plane_manifest_sha256(source_root)
        self.assertEqual(
            cli.source_control_plane_manifest(source_root),
            source_digest,
        )

        with tempfile.TemporaryDirectory() as directory:
            copied_root = Path(directory)
            shutil.copy2(MODULE_PATH, copied_root / MODULE_PATH.name)
            package = copied_root / 'deploy_control_plane'
            package.mkdir()
            for name in manifest.MANAGED_MODULES:
                shutil.copy2(source_root / 'deploy_control_plane' / name, package / name)
            original = manifest.control_plane_manifest_sha256(copied_root)
            with (package / 'runtime.py').open('ab') as target:
                target.write(b'\n# manifest tamper fixture\n')
            self.assertNotEqual(
                manifest.control_plane_manifest_sha256(copied_root),
                original,
            )

    def test_installed_control_plane_uses_one_exact_version_pointer(self) -> None:
        if os.name == 'nt':
            raise unittest.SkipTest('production control-plane links require POSIX semantics')
        with tempfile.TemporaryDirectory() as directory:
            install_root = Path(directory) / 'p2p-transmission'
            versions = install_root / 'control-plane-versions'
            candidate = install_root / 'candidate'
            package = candidate / 'deploy_control_plane'
            versions.mkdir(parents=True)
            package.mkdir(parents=True)
            shutil.copy2(MODULE_PATH, candidate / 'deploy-release.py')
            for name in manifest.MANAGED_MODULES:
                shutil.copy2(
                    MODULE_PATH.parent / 'deploy_control_plane' / name,
                    package / name,
                )
            digest = manifest.control_plane_manifest_sha256(candidate)
            version = versions / digest
            candidate.rename(version)
            current = install_root / 'current'
            current.symlink_to(f'control-plane-versions/{digest}', target_is_directory=True)

            with (
                patch.object(
                    manifest,
                    '_require_root_directory',
                    side_effect=lambda path, _mode: path.resolve(strict=True),
                ),
                patch.object(manifest, '_require_root_file'),
                patch.object(
                    manifest,
                    '_required_root_uid',
                    side_effect=lambda metadata: metadata.st_uid,
                ),
            ):
                actual, _ = manifest.validate_installed_control_plane(
                    current / 'deploy-release.py',
                    version / 'deploy-release.py',
                    version / 'deploy_control_plane',
                    digest,
                )
                self.assertEqual(actual, digest)

                (version / 'unexpected.txt').write_text('unsafe', encoding='utf-8')
                with self.assertRaisesRegex(SystemExit, 'unexpected or missing entries'):
                    manifest.validate_installed_control_plane(
                        current / 'deploy-release.py',
                        version / 'deploy-release.py',
                        version / 'deploy_control_plane',
                        digest,
                    )

    def test_wrapper_isolates_the_fixed_python_import_path(self) -> None:
        wrapper = DEPLOY_WRAPPER.read_text(encoding='utf-8')
        self.assertTrue(wrapper.startswith('#!/bin/bash\n'))
        self.assertIn('/usr/bin/env -i', wrapper)
        self.assertIn(
            'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            wrapper,
        )
        self.assertIn('LANG=C.UTF-8', wrapper)
        self.assertIn('LC_ALL=C.UTF-8', wrapper)
        self.assertIn('/usr/bin/python3 -I -B -X utf8', wrapper)
        self.assertIn(
            '/usr/local/libexec/p2p-transmission/current/deploy-release.py',
            wrapper,
        )
        self.assertIn('/usr/bin/readlink -e -- "$CONTROL_PLANE_ENTRY"', wrapper)
        self.assertIn('control-plane-versions/[0-9a-f]{64}', wrapper)
        self.assertIn('"$PHYSICAL_CONTROL_PLANE_ENTRY" "$@"', wrapper)

    def test_stage_sudoers_requires_the_bound_control_plane_digest(self) -> None:
        sudoers = DEPLOY_SUDOERS.read_text(encoding='utf-8')
        self.assertIn(
            'stage --archive * --image-archive * --version * '
            '--expected-control-plane-sha256 *',
            sudoers,
        )
        self.assertNotIn('--retired-files', sudoers)
        self.assertNotIn('p2p-transmission-deploy stage *,', sudoers)

    def test_bootstrap_atomically_installs_the_read_only_module_bundle(self) -> None:
        bootstrap = BOOTSTRAP_HOST.read_text(encoding='utf-8')
        self.assertTrue(bootstrap.startswith('#!/bin/bash\n'))
        self.assertIn(
            "readonly PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'",
            bootstrap,
        )
        self.assertIn('control-plane-manifest --format sha256', bootstrap)
        self.assertIn('python3 -I -B -X utf8 "$HELPER_SOURCE"', bootstrap)
        self.assertIn('control-plane-versions', bootstrap)
        for module in manifest.MANAGED_MODULES:
            self.assertIn(f"  '{module}'", bootstrap)
        self.assertIn("install -o root -g root -m 0444", bootstrap)
        self.assertIn('"$HELPER_SOURCE" "$temporary/deploy-release.py"', bootstrap)
        self.assertIn('chmod 0555', bootstrap)
        self.assertIn('ln -s "control-plane-versions/$digest" "$pointer_tmp"', bootstrap)
        self.assertIn('mv -fT -- "$pointer_tmp" "$CONTROL_PLANE_CURRENT"', bootstrap)
        self.assertNotIn('mv -fT -- "$pointer_tmp" "$CONTROL_PLANE_PACKAGE"', bootstrap)
        atomic_file_sync = bootstrap.index('  fsync_regular_file "$temporary"\n')
        atomic_rename = bootstrap.index('  mv -fT -- "$temporary" "$target"\n')
        atomic_parent_sync = bootstrap.index(
            '  fsync_directory "$target_dir"\n',
            atomic_rename,
        )
        self.assertLess(atomic_file_sync, atomic_rename)
        self.assertLess(atomic_rename, atomic_parent_sync)
        temporary_tree_sync = bootstrap.index(
            '    fsync_control_plane_version "$temporary"\n'
        )
        version_rename = bootstrap.index('    mv -- "$temporary" "$version_root"\n')
        selected_tree_sync = bootstrap.index(
            '  fsync_control_plane_version "$version_root"\n'
        )
        current_rename = bootstrap.index(
            '  mv -fT -- "$pointer_tmp" "$CONTROL_PLANE_CURRENT"\n'
        )
        current_parent_sync = bootstrap.index(
            '  fsync_directory "$HELPER_DIR"\n',
            current_rename,
        )
        self.assertLess(temporary_tree_sync, version_rename)
        self.assertLess(version_rename, selected_tree_sync)
        self.assertLess(selected_tree_sync, current_rename)
        self.assertLess(current_rename, current_parent_sync)
        self.assertIn('flock -n "$CONTROL_PLANE_LOCK_FD"', bootstrap)
        self.assertIn(
            '[[ ! -e "$PENDING_RELEASE" && ! -L "$PENDING_RELEASE" ]]',
            bootstrap,
        )
        self.assertIn('control-plane-status --expected-sha256 "$digest"', bootstrap)
        self.assertIn('unsupported standalone control-plane entry exists', bootstrap)
        self.assertNotIn('remove_legacy_control_plane_layout', bootstrap)
        self.assertIn('validate_source_manifest', bootstrap)
        self.assertIn('write_seed_source_manifest "$temporary"', bootstrap)
        self.assertIn('existing application root has no current source manifest', bootstrap)
        acquire = bootstrap.index('  acquire_bootstrap_control_plane_lock\n')
        pending_guard = bootstrap.index(
            '  assert_no_pending_release_for_control_plane_update\n'
        )
        install = bootstrap.index('  install_control_plane_bundle >/dev/null\n')
        release = bootstrap.index('  release_bootstrap_control_plane_lock\n')
        status = bootstrap.index('\ncheck_control_plane_bundle\n')
        self.assertLess(acquire, install)
        self.assertLess(acquire, pending_guard)
        self.assertLess(pending_guard, install)
        self.assertLess(install, release)
        self.assertLess(release, status)

        cli_source = CONTROL_PLANE_CLI.read_text(encoding='utf-8')
        dispatch = cli_source[cli_source.index('    args = parser.parse_args()') :]
        self.assertLess(
            dispatch.index('with release_state.production_control_plane_lock()'),
            dispatch.index('if args.action == "control-plane-status"'),
        )

    def test_bootstrap_consumes_only_root_owned_head_snapshots(self) -> None:
        bootstrap = BOOTSTRAP_HOST.read_text(encoding='utf-8')
        self.assertIn(
            'status --porcelain=v1 --untracked-files=all --ignored=matching',
            bootstrap,
        )
        self.assertIn("git_root = source_root / '.git'", bootstrap)
        self.assertIn('for current, directory_names, file_names in os.walk(git_root', bootstrap)
        self.assertIn('value.st_uid != 0', bootstrap)
        self.assertIn('value.st_gid != 0', bootstrap)
        self.assertIn('value.st_nlink != 1', bootstrap)
        self.assertIn('trusted_git archive --format=tar', bootstrap)
        self.assertIn(
            'HELPER_SOURCE="$TRUSTED_SOURCE_ROOT/deploy/scripts/deploy-release.py"',
            bootstrap,
        )
        self.assertIn(
            'SUDOERS_SOURCE="$TRUSTED_SOURCE_ROOT/deploy/production/sudoers/',
            bootstrap,
        )
        self.assertIn('tar --extract --file="$TRUSTED_SOURCE_ARCHIVE"', bootstrap)
        self.assertNotIn('git -C "$SOURCE_ROOT" archive', bootstrap)
        self.assertIn('snapshot_authorized_key_file', bootstrap)
        self.assertIn('[[ -n "$requested" ]] || return 0', bootstrap)
        self.assertIn("os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)", bootstrap)
        source_snapshot = bootstrap.index('\nvalidate_trusted_source_root\n')
        key_snapshot = bootstrap.index('\nsnapshot_authorized_key_file\n')
        apply_changes = bootstrap.index("\nif [[ \"$MODE\" == 'apply' ]]; then", key_snapshot)
        self.assertLess(source_snapshot, key_snapshot)
        self.assertLess(key_snapshot, apply_changes)

        lines = bootstrap.splitlines()
        compiled_blocks = 0
        for index, line in enumerate(lines):
            if "<<'PY'" not in line:
                continue
            start = index + 1
            if line.rstrip().endswith('\\'):
                while start < len(lines):
                    continued = lines[start].rstrip().endswith('\\')
                    start += 1
                    if not continued:
                        break
            end = lines.index('PY', start)
            compile('\n'.join(lines[start:end]), f'bootstrap:{start + 1}', 'exec')
            compiled_blocks += 1
        self.assertGreaterEqual(compiled_blocks, 6)

    def test_effective_sshd_value_consumes_complete_sshd_output(self) -> None:
        bootstrap = BOOTSTRAP_HOST.read_text(encoding='utf-8')
        self.assertIn(
            "awk -v expected=\"$key\" "
            "'$1 == expected && !found { print $2; found = 1 }'",
            bootstrap,
        )
        self.assertNotIn('$1 == expected { print $2; exit }', bootstrap)


if __name__ == '__main__':
    unittest.main()
