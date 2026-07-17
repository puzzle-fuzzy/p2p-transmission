#!/usr/bin/env python3
"""Reject browser-client module dependencies that recreate runtime cycles."""

from __future__ import annotations

from pathlib import Path
import tomllib


ROOT = Path(__file__).resolve().parents[1]
WEB_SOURCE = ROOT / "rust" / "apps" / "web" / "src"
UI_SHELL = ROOT / "rust" / "crates" / "ui-shell"
FORBIDDEN_DEPENDENCIES = {
    "app_state.rs": ("crate::",),
    "realtime_target.rs": ("crate::",),
    "realtime_runtime.rs": (
        "crate::browser_lifecycle",
        "crate::realtime_connection",
        "crate::realtime_session",
    ),
    "realtime_connection.rs": (
        "crate::browser_lifecycle",
        "crate::realtime_session",
    ),
    "browser_lifecycle.rs": ("crate::realtime_session",),
}
UI_SHELL_ALLOWED_RUNTIME_DEPENDENCIES = {"dioxus"}
UI_SHELL_FORBIDDEN_SOURCE_IMPORTS = (
    "use axum",
    "axum::",
    "dioxus::web::",
    "p2p_browser_platform",
    "p2p_protocol",
    "wasm_bindgen::",
    "web_sys::",
)
WORKSPACE_FORBIDDEN_DIOXUS_FEATURES = {
    "desktop",
    "fullstack",
    "liveview",
    "mobile",
    "server",
    "ssr",
    "web",
}


def load_toml(path: Path) -> dict[str, object]:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def ui_shell_runtime_dependencies(manifest: dict[str, object]) -> set[str]:
    dependencies = set(manifest.get("dependencies", {}))
    targets = manifest.get("target", {})
    if isinstance(targets, dict):
        for target in targets.values():
            if isinstance(target, dict):
                dependencies.update(target.get("dependencies", {}))
    return dependencies


def main() -> None:
    violations: list[str] = []
    for filename, forbidden in FORBIDDEN_DEPENDENCIES.items():
        path = WEB_SOURCE / filename
        source = path.read_text(encoding="utf-8")
        for dependency in forbidden:
            if dependency in source:
                violations.append(f"{path.relative_to(ROOT)} imports {dependency}")

    ui_shell_manifest_path = UI_SHELL / "Cargo.toml"
    ui_shell_manifest = load_toml(ui_shell_manifest_path)
    unexpected_dependencies = ui_shell_runtime_dependencies(
        ui_shell_manifest
    ) - UI_SHELL_ALLOWED_RUNTIME_DEPENDENCIES
    for dependency in sorted(unexpected_dependencies):
        violations.append(
            f"{ui_shell_manifest_path.relative_to(ROOT)} has forbidden runtime "
            f"dependency {dependency}"
        )

    for path in sorted((UI_SHELL / "src").rglob("*.rs")):
        source = path.read_text(encoding="utf-8")
        for dependency in UI_SHELL_FORBIDDEN_SOURCE_IMPORTS:
            if dependency in source:
                violations.append(f"{path.relative_to(ROOT)} imports {dependency}")

    workspace_manifest = load_toml(ROOT / "Cargo.toml")
    workspace_dependencies = workspace_manifest["workspace"]["dependencies"]
    dioxus_features = set(workspace_dependencies["dioxus"].get("features", ()))
    for feature in sorted(dioxus_features & WORKSPACE_FORBIDDEN_DIOXUS_FEATURES):
        violations.append(
            "workspace dioxus baseline enables platform feature "
            f"{feature}; platform crates must opt in locally"
        )

    if violations:
        details = "\n".join(f"- {violation}" for violation in violations)
        raise SystemExit(f"browser architecture dependency check failed:\n{details}")

    print(
        "Browser architecture dependency check passed: "
        f"checked {len(FORBIDDEN_DEPENDENCIES)} module boundaries and the shared UI boundary."
    )


if __name__ == "__main__":
    main()
