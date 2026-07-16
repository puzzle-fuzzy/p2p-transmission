#!/usr/bin/env python3
"""Enforce gzip budgets for the production Dioxus browser entrypoint."""

from __future__ import annotations

import argparse
import gzip
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIST = ROOT / "target" / "dx" / "p2p-web" / "release" / "web" / "public"
WASM_GZIP_BUDGET = 512 * 1024
JAVASCRIPT_GZIP_BUDGET = 20 * 1024
ENTRYPOINT_GZIP_BUDGET = 528 * 1024


def gzip_size(path: Path) -> int:
    return len(gzip.compress(path.read_bytes(), compresslevel=9, mtime=0))


def format_kib(size: int) -> str:
    return f"{size / 1024:.1f} KiB"


def assets_with_suffix(dist: Path, suffix: str) -> list[Path]:
    assets = dist / "assets"
    return sorted(path for path in assets.rglob(f"*{suffix}") if path.is_file())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=DEFAULT_DIST)
    args = parser.parse_args()

    dist = args.dist.resolve()
    wasm_files = assets_with_suffix(dist, ".wasm")
    javascript_files = assets_with_suffix(dist, ".js")
    if not wasm_files or not javascript_files:
        raise SystemExit(f"missing production WebAssembly or JavaScript assets in {dist}")

    wasm_gzip = sum(gzip_size(path) for path in wasm_files)
    javascript_gzip = sum(gzip_size(path) for path in javascript_files)
    entrypoint_gzip = wasm_gzip + javascript_gzip

    rows = (
        ("WebAssembly", wasm_gzip, WASM_GZIP_BUDGET),
        ("JavaScript", javascript_gzip, JAVASCRIPT_GZIP_BUDGET),
        ("Browser entrypoint", entrypoint_gzip, ENTRYPOINT_GZIP_BUDGET),
    )
    failures: list[str] = []
    for label, actual, budget in rows:
        print(f"{label}: {format_kib(actual)} gzip / {format_kib(budget)} budget")
        if actual > budget:
            failures.append(f"{label} exceeds its gzip budget by {format_kib(actual - budget)}")

    if failures:
        raise SystemExit("; ".join(failures))


if __name__ == "__main__":
    main()
