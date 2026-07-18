from __future__ import annotations

import ast
import unittest
from pathlib import Path


SCRIPTS_ROOT = Path(__file__).resolve().parent
PACKAGE_ROOT = SCRIPTS_ROOT / 'deployment_supervisor'
MODULE_LIMITS = {
    '__init__.py': 20,
    'cli.py': 150,
    'diagnostics.py': 150,
    'monitor.py': 250,
    # This boundary intentionally keeps owned-file I/O and POSIX flock checks together.
    'security.py': 400,
    'state.py': 280,
    'worker.py': 320,
}
ALLOWED_INTERNAL_IMPORTS = {
    '__init__.py': set(),
    'state.py': set(),
    'security.py': {'state'},
    'worker.py': {'security', 'state'},
    'monitor.py': {'security', 'state'},
    'cli.py': {'diagnostics', 'monitor', 'state', 'worker'},
    'diagnostics.py': {'security', 'state'},
}
SPLIT_TEST_FILES = {
    'test_deployment_supervisor_architecture.py',
    'test_deployment_supervisor_bundle.py',
    'test_deployment_supervisor_cli.py',
    'test_deployment_supervisor_diagnostics.py',
    'test_deployment_supervisor_monitor.py',
    'test_deployment_supervisor_security.py',
    'test_deployment_supervisor_state.py',
    'test_deployment_supervisor_worker.py',
}


class DeploymentSupervisorArchitectureTests(unittest.TestCase):
    def test_modules_are_bounded_and_dependencies_are_one_way(self) -> None:
        actual = {path.name for path in PACKAGE_ROOT.glob('*.py')}
        self.assertEqual(actual, set(MODULE_LIMITS))
        for name, limit in MODULE_LIMITS.items():
            with self.subTest(module=name):
                source = (PACKAGE_ROOT / name).read_text(encoding='utf-8')
                self.assertLessEqual(len(source.splitlines()), limit)
                dependencies: set[str] = set()
                for node in ast.walk(ast.parse(source, filename=name)):
                    if not isinstance(node, ast.ImportFrom) or node.level != 1:
                        continue
                    if node.module:
                        dependencies.add(node.module.split('.')[0])
                    else:
                        dependencies.update(alias.name for alias in node.names)
                self.assertEqual(dependencies, ALLOWED_INTERNAL_IMPORTS[name])

    def test_stable_entrypoint_only_dispatches_to_cli(self) -> None:
        entrypoint = SCRIPTS_ROOT / 'deployment-supervisor.py'
        source = entrypoint.read_text(encoding='utf-8')
        self.assertLessEqual(len(source.splitlines()), 20)
        tree = ast.parse(source)
        imports = [node for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)]
        self.assertEqual(
            [(node.module, [alias.name for alias in node.names]) for node in imports],
            [('deployment_supervisor.cli', ['main'])],
        )

    def test_tests_remain_split_and_the_old_aggregate_is_absent(self) -> None:
        self.assertFalse((SCRIPTS_ROOT / 'test_deployment_supervisor.py').exists())
        for name in SPLIT_TEST_FILES:
            with self.subTest(test_file=name):
                lines = (SCRIPTS_ROOT / name).read_text(encoding='utf-8').splitlines()
                self.assertLessEqual(len(lines), 500)
        support = SCRIPTS_ROOT / 'deployment_supervisor_test_support.py'
        self.assertLessEqual(len(support.read_text(encoding='utf-8').splitlines()), 100)


if __name__ == '__main__':
    unittest.main()
