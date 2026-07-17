#!/usr/bin/env python3
"""Enforce gzip budgets for the production Dioxus browser entrypoint."""

from __future__ import annotations

import argparse
import gzip
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIST = ROOT / "target" / "dx" / "p2p-web" / "release" / "web" / "public"
APP_STYLESHEET = ROOT / "rust" / "apps" / "web" / "assets" / "main.css"
HTML_GZIP_BUDGET = 8 * 1024
WASM_GZIP_BUDGET = 480 * 1024
JAVASCRIPT_GZIP_BUDGET = 18 * 1024
CSS_GZIP_BUDGET = 6 * 1024
ENTRYPOINT_GZIP_BUDGET = 500 * 1024


def gzip_size(path: Path) -> int:
    return len(gzip.compress(path.read_bytes(), compresslevel=6, mtime=0))


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
    index_html = dist / "index.html"
    if not index_html.is_file() or not wasm_files or not javascript_files:
        raise SystemExit(
            f"missing production HTML, WebAssembly, or JavaScript assets in {dist}"
        )

    html_gzip = gzip_size(index_html)
    wasm_gzip = sum(gzip_size(path) for path in wasm_files)
    javascript_gzip = sum(gzip_size(path) for path in javascript_files)
    css_gzip = gzip_size(APP_STYLESHEET)
    entrypoint_gzip = wasm_gzip + javascript_gzip + css_gzip

    rows = (
        ("HTML shell", html_gzip, HTML_GZIP_BUDGET),
        ("WebAssembly", wasm_gzip, WASM_GZIP_BUDGET),
        ("JavaScript", javascript_gzip, JAVASCRIPT_GZIP_BUDGET),
        ("CSS", css_gzip, CSS_GZIP_BUDGET),
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
