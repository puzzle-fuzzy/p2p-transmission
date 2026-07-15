from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
CONFIG = REPOSITORY_ROOT / "apps/web/playwright.spike.config.ts"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the Dioxus/Axum WebRTC spike in real Chromium contexts.",
    )
    parser.add_argument(
        "--file-mib",
        type=int,
        default=8,
        help="Synthetic file size in MiB (default: 8).",
    )
    parser.add_argument(
        "--browser",
        choices=["chromium", "firefox", "webkit", "all"],
        default="chromium",
        help="Playwright project to run (default: chromium).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not 0 <= args.file_mib <= 128:
        raise SystemExit("--file-mib must be between 0 and 128")

    environment = os.environ.copy()
    environment["SPIKE_FILE_MIB"] = str(args.file_mib)
    command = [
        "bun",
        "run",
        "--cwd",
        "apps/web",
        "e2e",
        "--config",
        str(CONFIG),
    ]
    if args.browser != "all":
        command.extend(["--project", args.browser])
    return subprocess.run(
        command,
        cwd=REPOSITORY_ROOT,
        env=environment,
        check=False,
    ).returncode


if __name__ == "__main__":
    sys.exit(main())
