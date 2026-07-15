#!/usr/bin/env python3
"""Capture the current Rust 2.0 AppShell at desktop and mobile viewports."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    environment = os.environ.copy()
    environment["CAPTURE_V2_SHELL"] = "1"
    command = [
        "bun",
        "run",
        "--cwd",
        "apps/web",
        "e2e",
        "--config",
        str(ROOT / "apps" / "web" / "playwright.v2.config.ts"),
    ]
    print(f"$ {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=ROOT, env=environment, check=True)


if __name__ == "__main__":
    main()
