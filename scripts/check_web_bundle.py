#!/usr/bin/env python3
"""Enforce gzip budgets for the production Dioxus browser entrypoint."""

from __future__ import annotations

import argparse
import gzip
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIST = ROOT / "target" / "dx" / "p2p-web" / "release" / "web" / "public"
APP_STYLESHEET = ROOT / "rust" / "apps" / "web" / "assets" / "main.css"
# The native web-shell test caps the fully injected source response at 6 KiB.
# Keeping Dioxus' generated template under 2 KiB makes the final response stay
# below 8 KiB raw even after release asset tags are added; this is stricter than
# the historical 8 KiB gzip ceiling.
HTML_TEMPLATE_RAW_BUDGET = 2 * 1024
HTML_TEMPLATE_GZIP_BUDGET = 8 * 1024
WASM_GZIP_BUDGET = 480 * 1024
JAVASCRIPT_GZIP_BUDGET = 18 * 1024
CSS_GZIP_BUDGET = 6 * 1024
ENTRYPOINT_GZIP_BUDGET = 500 * 1024
SSR_LOBBY_START = "<!-- P2P_SSR_LOBBY_START -->"
SSR_LOBBY_END = "<!-- P2P_SSR_LOBBY_END -->"
ISLAND_MOUNT = '<div id="main" hidden inert aria-hidden="true"></div>'
BOOT_FALLBACK = 'id="boot-fallback"'


def gzip_size(path: Path) -> int:
    return len(gzip.compress(path.read_bytes(), compresslevel=6, mtime=0))


def format_kib(size: int) -> str:
    return f"{size / 1024:.1f} KiB"


def assets_with_suffix(dist: Path, suffix: str) -> list[Path]:
    assets = dist / "assets"
    return sorted(path for path in assets.rglob(f"*{suffix}") if path.is_file())


def shell_contract_failures(index_html: Path) -> list[str]:
    template = index_html.read_text(encoding="utf-8")
    failures: list[str] = []
    if template.count(SSR_LOBBY_START) != 1:
        failures.append("built HTML must contain exactly one SSR lobby start marker")
    if template.count(SSR_LOBBY_END) != 1:
        failures.append("built HTML must contain exactly one SSR lobby end marker")
    if template.count(ISLAND_MOUNT) != 1:
        failures.append("built HTML must contain one hidden inert #main island mount")
    if BOOT_FALLBACK in template:
        failures.append("built HTML still contains the deleted handwritten lobby fallback")
    if not failures and not (
        template.index(SSR_LOBBY_START)
        < template.index(SSR_LOBBY_END)
        < template.index(ISLAND_MOUNT)
    ):
        failures.append("SSR lobby markers must precede the #main island mount")
    return failures


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
    html_raw = index_html.stat().st_size
    wasm_gzip = sum(gzip_size(path) for path in wasm_files)
    javascript_gzip = sum(gzip_size(path) for path in javascript_files)
    css_gzip = gzip_size(APP_STYLESHEET)
    entrypoint_gzip = wasm_gzip + javascript_gzip + css_gzip

    rows = (
        ("HTML template", html_raw, HTML_TEMPLATE_RAW_BUDGET, "raw"),
        ("HTML template", html_gzip, HTML_TEMPLATE_GZIP_BUDGET, "gzip"),
        ("WebAssembly", wasm_gzip, WASM_GZIP_BUDGET, "gzip"),
        ("JavaScript", javascript_gzip, JAVASCRIPT_GZIP_BUDGET, "gzip"),
        ("CSS", css_gzip, CSS_GZIP_BUDGET, "gzip"),
        ("Browser entrypoint", entrypoint_gzip, ENTRYPOINT_GZIP_BUDGET, "gzip"),
    )
    failures = shell_contract_failures(index_html)
    if failures:
        print("SSR shell contract: failed")
    else:
        print("SSR shell contract: passed")
    for label, actual, budget, encoding in rows:
        print(
            f"{label}: {format_kib(actual)} {encoding} / "
            f"{format_kib(budget)} budget"
        )
        if actual > budget:
            failures.append(
                f"{label} exceeds its {encoding} budget by "
                f"{format_kib(actual - budget)}"
            )

    if failures:
        raise SystemExit("; ".join(failures))


if __name__ == "__main__":
    main()
