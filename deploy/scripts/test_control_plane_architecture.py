from __future__ import annotations

import ast
import unittest
from pathlib import Path


SCRIPTS_ROOT = Path(__file__).resolve().parent
PACKAGE_ROOT = SCRIPTS_ROOT / 'deploy_control_plane'
SPLIT_TEST_FILES = {
    'test_control_plane_artifacts.py',
    'test_control_plane_capacity.py',
    'test_control_plane_database.py',
    'test_control_plane_manifest_bootstrap.py',
    'test_control_plane_offsite_backup.py',
    'test_control_plane_release_state.py',
    'test_control_plane_runtime.py',
    'test_control_plane_runtime_maintenance.py',
    'test_control_plane_workflow_contract.py',
}


class ControlPlaneArchitectureTests(unittest.TestCase):
    def test_modules_remain_bounded_by_one_operational_responsibility(self) -> None:
        maximum_lines = {
            '__init__.py': 20,
            'artifacts.py': 450,
            'capacity.py': 280,
            'cli.py': 250,
            'common.py': 300,
            'database.py': 400,
            'docker_archive.py': 300,
            'manifest.py': 300,
            'oci_archive.py': 300,
            'offsite_backup.py': 300,
            'release_state.py': 550,
            'runtime.py': 500,
        }
        actual_modules = {path.name for path in PACKAGE_ROOT.glob('*.py')}
        self.assertEqual(actual_modules, set(maximum_lines))
        for name, limit in maximum_lines.items():
            with self.subTest(module=name):
                lines = (PACKAGE_ROOT / name).read_text(encoding='utf-8').splitlines()
                self.assertLessEqual(len(lines), limit)

    def test_split_modules_import_standard_library_dependencies_directly(self) -> None:
        forbidden_reexports = {
            'argparse',
            'base64',
            'binascii',
            'hashlib',
            'hmac',
            'json',
            'secrets',
            'shutil',
            'sqlite3',
            'stat',
            'tarfile',
            'time',
            'urllib',
            'closing',
            'contextmanager',
            'dataclass',
            'replace',
            'datetime',
            'timezone',
            'BinaryIO',
            'Iterator',
        }
        for path in PACKAGE_ROOT.glob('*.py'):
            tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
            for node in ast.walk(tree):
                if not isinstance(node, ast.ImportFrom):
                    continue
                if node.level == 1 and node.module == 'common':
                    imported = {alias.name for alias in node.names}
                    with self.subTest(module=path.name):
                        self.assertFalse(imported & forbidden_reexports)

    def test_tests_remain_split_by_operational_responsibility(self) -> None:
        self.assertFalse((SCRIPTS_ROOT / 'test_deploy_release.py').exists())
        for name in SPLIT_TEST_FILES:
            with self.subTest(test_file=name):
                source = (SCRIPTS_ROOT / name).read_text(encoding='utf-8')
                self.assertLessEqual(len(source.splitlines()), 500)
                self.assertNotIn('ControlPlaneTestFacade', source)

        support_source = (SCRIPTS_ROOT / 'deploy_test_support.py').read_text(
            encoding='utf-8'
        )
        self.assertLessEqual(len(support_source.splitlines()), 100)
        support_tree = ast.parse(support_source)
        for node in ast.walk(support_tree):
            if isinstance(node, ast.ImportFrom):
                imported_module = node.module or ''
                self.assertFalse(imported_module.startswith('deploy_control_plane'))
            elif isinstance(node, ast.Import):
                imported_modules = {alias.name for alias in node.names}
                self.assertFalse(
                    any(name.startswith('deploy_control_plane') for name in imported_modules)
                )


if __name__ == '__main__':
    unittest.main()
