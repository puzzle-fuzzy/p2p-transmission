#!/usr/bin/env python3
"""Build the deployment supervisor as one self-contained zipapp artifact."""

from __future__ import annotations

import argparse
import os
import shutil
import tempfile
import zipapp
from pathlib import Path
from typing import Optional


SCRIPTS_ROOT = Path(__file__).resolve().parent
ENTRYPOINT = SCRIPTS_ROOT / 'deployment-supervisor.py'
PACKAGE_ROOT = SCRIPTS_ROOT / 'deployment_supervisor'
MANAGED_MODULES = {
    '__init__.py',
    'cli.py',
    'diagnostics.py',
    'monitor.py',
    'security.py',
    'state.py',
    'worker.py',
}


def build_bundle(output: Path) -> None:
    actual_modules = {path.name for path in PACKAGE_ROOT.glob('*.py')}
    if actual_modules != MANAGED_MODULES:
        raise SystemExit('deployment supervisor package has unexpected modules')
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f'.{output.name}.build-',
        dir=output.parent,
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    temporary.unlink()
    try:
        with tempfile.TemporaryDirectory() as staging_name:
            staging = Path(staging_name)
            shutil.copy2(ENTRYPOINT, staging / '__main__.py')
            staged_package = staging / 'deployment_supervisor'
            staged_package.mkdir()
            for name in sorted(MANAGED_MODULES):
                shutil.copy2(PACKAGE_ROOT / name, staged_package / name)
            zipapp.create_archive(
                staging,
                target=temporary,
                interpreter='/usr/bin/env python3',
                compressed=True,
            )
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    arguments = parser.parse_args(argv)
    build_bundle(arguments.output)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
