from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    environment = os.environ.copy()
    environment["CAPTURE_V1_BASELINE"] = "1"
    command = [
        "bun",
        "run",
        "--cwd",
        "apps/web",
        "e2e",
        "v1-baseline.spec.ts",
    ]
    return subprocess.run(
        command,
        cwd=REPOSITORY_ROOT,
        env=environment,
        check=False,
    ).returncode


if __name__ == "__main__":
    sys.exit(main())
