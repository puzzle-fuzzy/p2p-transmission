#!/usr/bin/env python3
"""Build the Dioxus shell and serve it from the Rust 2.0 Axum binary."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess


ROOT = Path(__file__).resolve().parents[1]
def run(command: list[str], *, cwd: Path = ROOT, env: dict[str, str] | None = None) -> None:
    print(f"$ {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True)


def web_dist(profile: str) -> Path:
    return ROOT / "target" / "dx" / "p2p-web" / profile / "web" / "public"


def build_web(profile: str) -> Path:
    output = web_dist(profile).resolve()
    expected = (ROOT / "target" / "dx" / "p2p-web" / profile / "web" / "public").resolve()
    if output != expected:
        raise SystemExit(f"refusing to clean unexpected Dioxus output path: {output}")
    if output.is_dir():
        shutil.rmtree(output)

    command = ["dx", "build", "--web", "--package", "p2p-web", "--locked"]
    if profile == "release":
        command.extend(["--release", "--debug-symbols", "false"])
    run(command)

    if not (output / "index.html").is_file():
        raise SystemExit(f"Dioxus build did not create {output / 'index.html'}")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("debug", "release"), default="release")
    parser.add_argument("--addr", default="127.0.0.1:3410")
    parser.add_argument("--build-only", action="store_true")
    args = parser.parse_args()

    output = build_web(args.profile)
    if args.build_only:
        print(output)
        return

    environment = os.environ.copy()
    environment["P2P_ADDR"] = args.addr
    environment["P2P_WEB_DIST"] = str(output)
    environment.setdefault(
        "P2P_DATABASE_PATH", str(ROOT / "target" / "p2p-v2" / "control.sqlite3")
    )
    environment.setdefault("RUST_LOG", "p2p_server=info,tower_http=info")

    command = ["cargo", "run", "--locked", "-p", "p2p-server"]
    if args.profile == "release":
        command.append("--release")
    run(command, env=environment)


if __name__ == "__main__":
    main()
