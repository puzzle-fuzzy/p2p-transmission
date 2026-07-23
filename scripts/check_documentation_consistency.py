#!/usr/bin/env python3
"""Check documentation against the current release and repository layout."""

from __future__ import annotations

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
RELEASE_MANUAL = ROOT / "docs/release/RELEASE.md"
HEALTH_WORKFLOW = ROOT / ".github/workflows/production-health.yml"
EXPECTED_HEALTH_CRON = "17 */2 * * *"
STALE_REFERENCES = ("docs/参考", "docs\\参考", "target-3411")
STALE_HEALTH_CADENCE_REFERENCES = ("每 6 小时", "每 6小时", "每六小时")


def documentation_files() -> list[Path]:
    ignored = {".git", "node_modules", "target", "test-results"}
    return sorted(
        path
        for path in ROOT.rglob("*.md")
        if not ignored.intersection(path.parts)
    )


def check_health_schedule(failures: list[str]) -> None:
    workflow = HEALTH_WORKFLOW.read_text(encoding="utf-8")
    release_manual = RELEASE_MANUAL.read_text(encoding="utf-8")
    cron = re.search(r"cron:\s*[\"']([^\"']+)[\"']", workflow)
    if cron is None or cron.group(1) != EXPECTED_HEALTH_CRON:
        failures.append(
            "production-health.yml must schedule the documented two-hour health check"
        )
    if "每 2 小时" not in release_manual:
        failures.append("RELEASE.md must describe the production health check cadence")
    for path in documentation_files():
        text = path.read_text(encoding="utf-8")
        for reference in STALE_HEALTH_CADENCE_REFERENCES:
            if reference in text:
                failures.append(
                    f"{path.relative_to(ROOT)} contains stale health cadence {reference}"
                )


def check_stale_references(failures: list[str]) -> None:
    for path in documentation_files():
        text = path.read_text(encoding="utf-8")
        for reference in STALE_REFERENCES:
            if reference in text:
                failures.append(
                    f"{path.relative_to(ROOT)} contains removed path reference {reference}"
                )


def main() -> None:
    failures: list[str] = []
    check_health_schedule(failures)
    check_stale_references(failures)
    if failures:
        raise SystemExit(
            "documentation consistency check failed:\n- " + "\n- ".join(failures)
        )
    print(
        "Documentation consistency check passed: "
        f"health_cron={EXPECTED_HEALTH_CRON}, scanned={len(documentation_files())} markdown files"
    )


if __name__ == "__main__":
    main()
