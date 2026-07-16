#!/usr/bin/env python3
"""Run the canonical Rust Web application through Playwright."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-room", action="store_true")
    parser.add_argument("--capture-transfer", action="store_true")
    args = parser.parse_args()
    environment = os.environ.copy()
    if args.capture_room:
        environment["CAPTURE_ROOM"] = "1"
    if args.capture_transfer:
        environment["CAPTURE_TRANSFER"] = "1"
    command = [
        "bun",
        "run",
        "e2e",
    ]
    print(f"$ {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=ROOT, env=environment, check=True)


if __name__ == "__main__":
    main()
