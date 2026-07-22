#!/usr/bin/env python3
"""Run the canonical Rust Web application through Playwright."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import signal
import subprocess


ROOT = Path(__file__).resolve().parents[1]
BUN_VERSION_FILE = ROOT / ".bun-version"
PERFORMANCE_PROJECTS = ("performance-chromium", "performance-chromium-narrow")
DEFAULT_TIMEOUT_SECONDS = {
    "e2e": 600,
    "e2e:full": 1_800,
    "e2e:interop": 1_200,
    "e2e:performance": 240,
}


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


def process_timeout(script: str, override: float | None) -> float:
    if override is not None:
        if override <= 0:
            raise ValueError("--timeout-seconds must be greater than zero")
        return override
    configured = os.environ.get("P2P_E2E_TIMEOUT_SECONDS")
    if configured is not None:
        value = float(configured)
        if value <= 0:
            raise ValueError("P2P_E2E_TIMEOUT_SECONDS must be greater than zero")
        return value
    return DEFAULT_TIMEOUT_SECONDS[script]


def start_process(command: list[str], environment: dict[str, str]) -> subprocess.Popen[bytes]:
    options: dict[str, object] = {}
    if os.name == "nt":
        options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
    return subprocess.Popen(command, cwd=ROOT, env=environment, **options)


def stop_process_tree(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            cwd=ROOT,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)


def run_command(
    command: list[str], environment: dict[str, str], *, timeout: float
) -> None:
    print(f"$ {' '.join(command)} (timeout={timeout:g}s)", flush=True)
    process = start_process(command, environment)
    try:
        returncode = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        stop_process_tree(process)
        raise SystemExit(
            f"E2E command timed out after {timeout:g}s; its process tree was terminated"
        ) from error
    except KeyboardInterrupt:
        stop_process_tree(process)
        raise
    if returncode:
        raise subprocess.CalledProcessError(returncode, command)


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
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        help="override the timeout for each Playwright command",
    )
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
    timeout = process_timeout(script, args.timeout_seconds)
    if args.performance:
        for index, project in enumerate(PERFORMANCE_PROJECTS):
            project_environment = environment.copy()
            project_environment["P2P_PERFORMANCE_PROJECT"] = project
            project_environment["P2P_PERFORMANCE_PORT"] = str(3411 + index)
            run_command(command, project_environment, timeout=timeout)
    else:
        run_command(command, environment, timeout=timeout)


if __name__ == "__main__":
    main()
