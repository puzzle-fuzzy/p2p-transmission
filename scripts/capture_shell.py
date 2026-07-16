#!/usr/bin/env python3
"""Capture the current AppShell at desktop and mobile viewports."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    environment = os.environ.copy()
    environment["CAPTURE_SHELL"] = "1"
    command = [
        "bun",
        "run",
        "e2e",
    ]
    print(f"$ {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=ROOT, env=environment, check=True)


if __name__ == "__main__":
    main()
