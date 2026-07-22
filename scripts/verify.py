#!/usr/bin/env python3
"""Run the native, WASM, release, and documentation gates."""

from __future__ import annotations

from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
NATIVE_PACKAGES = (
    "p2p-domain",
    "p2p-protocol",
    "p2p-transfer",
    "p2p-server",
    "p2p-ui-shell",
)


def run(command: list[str], *, cwd: Path = ROOT) -> None:
    print(f"$ {' '.join(command)}", flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def package_args(packages: tuple[str, ...]) -> list[str]:
    return [argument for package in packages for argument in ("-p", package)]


def main() -> None:
    run(["cargo", "fmt", "--all", "--", "--check"])
    run(["python", "-X", "utf8", "scripts/check_web_architecture.py"])
    run(["python", "-X", "utf8", "scripts/check_server_architecture.py"])
    run(["python", "-X", "utf8", "scripts/check_version_contract.py"])
    run([
        "cargo",
        "clippy",
        "--locked",
        *package_args(NATIVE_PACKAGES),
        "--all-targets",
        "--",
        "-D",
        "warnings",
    ])
    run(["cargo", "test", "--locked"])
    run([
        "cargo",
        "test",
        "--locked",
        "-p",
        "p2p-browser-platform",
        "-p",
        "p2p-web",
    ])
    run([
        "cargo",
        "clippy",
        "--locked",
        "-p",
        "p2p-browser-platform",
        "-p",
        "p2p-web",
        "--target",
        "wasm32-unknown-unknown",
        "--",
        "-D",
        "warnings",
    ])
    run(["cargo", "build", "--locked", "-p", "p2p-server", "--release"])
    run(["python", "-X", "utf8", "scripts/dev.py", "--profile", "release", "--build-only"])
    run(["python", "-X", "utf8", "scripts/check_web_bundle.py"])
    run(["python", "-X", "utf8", "scripts/check-doc-links.py"])
    run(["python", "-X", "utf8", "scripts/check_documentation_consistency.py"])
    run(["git", "diff", "--check"])


if __name__ == "__main__":
    main()
