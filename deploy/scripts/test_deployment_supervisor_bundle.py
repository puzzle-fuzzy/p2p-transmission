from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

import build_deployment_supervisor as builder


class DeploymentSupervisorBundleTests(unittest.TestCase):
    def test_bundle_is_one_runnable_artifact_with_the_exact_package(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / 'deployment-supervisor.py'
            builder.build_bundle(bundle)

            with zipfile.ZipFile(bundle) as archive:
                self.assertEqual(
                    {name for name in archive.namelist() if not name.endswith('/')},
                    {
                        '__main__.py',
                        *(f'deployment_supervisor/{name}' for name in builder.MANAGED_MODULES),
                    },
                )
            completed = subprocess.run(
                [sys.executable, '-I', '-B', '-X', 'utf8', str(bundle), '--help'],
                capture_output=True,
                check=False,
                text=True,
                timeout=10,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertIn('{start,wait,cleanup}', completed.stdout)


if __name__ == '__main__':
    unittest.main()
