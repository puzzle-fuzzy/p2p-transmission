#!/usr/bin/env python3
"""Run the canonical Rust Web application through Playwright."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
BUN_VERSION_FILE = ROOT / ".bun-version"


def bun_command() -> list[str]:
    expected = BUN_VERSION_FILE.read_text(encoding="utf-8").strip()
    installed = subprocess.run(
        ["bun", "--version"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout.strip()
    if installed == expected:
        return ["bun"]

    print(
        f"本机 Bun {installed} 与仓库固定版本 {expected} 不一致；"
        "使用固定版本运行浏览器验收。",
        flush=True,
    )
    return ["bunx", f"bun@{expected}"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--full",
        action="store_true",
        help="run the full browser regression suite instead of the default smoke tier",
    )
    parser.add_argument(
        "--performance",
        action="store_true",
        help="run the lightweight Chromium performance contracts",
    )
    parser.add_argument(
        "--interop",
        action="store_true",
        help="run Firefox and WebKit connection, buffered-transfer, and fallback contracts",
    )
    parser.add_argument("--capture-room", action="store_true")
    parser.add_argument("--capture-transfer", action="store_true")
    args = parser.parse_args()
    if args.performance and (args.full or args.capture_room or args.capture_transfer):
        parser.error("--performance cannot be combined with full or capture modes")
    if args.interop and (
        args.full or args.performance or args.capture_room or args.capture_transfer
    ):
        parser.error("--interop cannot be combined with other test modes")

    environment = os.environ.copy()
    if args.capture_room:
        environment["CAPTURE_ROOM"] = "1"
    if args.capture_transfer:
        environment["CAPTURE_TRANSFER"] = "1"
    run_full = args.full or args.capture_room or args.capture_transfer
    script = (
        "e2e:interop"
        if args.interop
        else (
            "e2e:performance"
            if args.performance
            else ("e2e:full" if run_full else "e2e")
        )
    )
    command = [*bun_command(), "run", script]
    print(f"$ {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=ROOT, env=environment, check=True)


if __name__ == "__main__":
    main()
