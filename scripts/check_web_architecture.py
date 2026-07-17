#!/usr/bin/env python3
"""Reject browser-client module dependencies that recreate runtime cycles."""

from __future__ import annotations

from pathlib import Path
import re
import tomllib


ROOT = Path(__file__).resolve().parents[1]
WEB_SOURCE = ROOT / "rust" / "apps" / "web" / "src"
BROWSER_PLATFORM_SOURCE = ROOT / "rust" / "crates" / "browser-platform" / "src"
UI_SHELL = ROOT / "rust" / "crates" / "ui-shell"
FORBIDDEN_DEPENDENCIES = {
    "app_state.rs": ("crate::", "p2p_browser_platform"),
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
    "app_bootstrap.rs": (
        "crate::join_request",
        "crate::lobby",
        "crate::room_view",
        "crate::waiting_room",
    ),
    "room_entry.rs": (
        "crate::app_bootstrap",
        "crate::join_request",
        "crate::lobby",
        "crate::room_view",
        "crate::waiting_room",
    ),
    "lobby.rs": (
        "crate::app_bootstrap",
        "crate::join_request",
        "crate::room_view",
        "crate::waiting_room",
    ),
    "waiting_room.rs": (
        "crate::app_bootstrap",
        "crate::join_request",
        "crate::lobby",
        "crate::room_entry",
        "crate::room_view",
    ),
    "join_request.rs": (
        "crate::app_bootstrap",
        "crate::lobby",
        "crate::room_entry",
        "crate::room_view",
        "crate::waiting_room",
    ),
    "room_view.rs": (
        "crate::app_bootstrap",
        "crate::lobby",
        "crate::room_entry",
        "crate::waiting_room",
    ),
    "transfer_panel/transfer_request_dialog.rs": (
        "crate::app_bootstrap",
        "crate::join_request",
        "crate::lobby",
        "crate::room_entry",
        "crate::room_view",
        "crate::waiting_room",
    ),
    "transfer_panel/recipient_picker_dialog.rs": (
        "crate::app_bootstrap",
        "crate::join_request",
        "crate::lobby",
        "crate::room_entry",
        "crate::room_view",
        "crate::waiting_room",
    ),
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
BROWSER_PLATFORM_FACADE_MAX_LINES = 240
BROWSER_PLATFORM_RESPONSIBILITY_MODULES = (
    "api",
    "capabilities",
    "navigation",
    "realtime",
    "session_storage",
    "ui",
)
BROWSER_PLATFORM_FACADE_FORBIDDEN_IMPLEMENTATION_MARKERS = (
    "web_sys::",
    "wasm_bindgen::",
    "js_sys::",
    "gloo_timers::",
    "thread_local!",
    "async fn request_json",
)
TRANSFER_EVENT_FACADE_MAX_LINES = 80
TRANSFER_EVENT_TRANSITION_MODULES = ("offer", "pause", "progress", "terminal")


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


def imports_dependency(source: str, dependency: str) -> bool:
    """Recognize direct paths and grouped `use crate::{...}` imports."""
    if dependency in source:
        return True
    if not dependency.startswith("crate::"):
        return False

    module = re.escape(dependency.removeprefix("crate::"))
    grouped_imports = re.finditer(r"\buse\s+crate::\{(.*?)\};", source, re.DOTALL)
    return any(
        re.search(rf"(?:^|\W){module}\s*(?:::|,|$)", match.group(1))
        for match in grouped_imports
    )


def main() -> None:
    violations: list[str] = []
    for filename, forbidden in FORBIDDEN_DEPENDENCIES.items():
        path = WEB_SOURCE / filename
        source = path.read_text(encoding="utf-8")
        for dependency in forbidden:
            if imports_dependency(source, dependency):
                violations.append(f"{path.relative_to(ROOT)} imports {dependency}")

    browser_platform_facade_path = BROWSER_PLATFORM_SOURCE / "lib.rs"
    browser_platform_facade = browser_platform_facade_path.read_text(encoding="utf-8")
    facade_lines = len(browser_platform_facade.splitlines())
    if facade_lines > BROWSER_PLATFORM_FACADE_MAX_LINES:
        violations.append(
            f"{browser_platform_facade_path.relative_to(ROOT)} has {facade_lines} lines; "
            f"facade limit is {BROWSER_PLATFORM_FACADE_MAX_LINES}"
        )
    for module in BROWSER_PLATFORM_RESPONSIBILITY_MODULES:
        module_path = BROWSER_PLATFORM_SOURCE / f"{module}.rs"
        if not module_path.is_file():
            violations.append(f"{module_path.relative_to(ROOT)} is missing")
        if f"mod {module};" not in browser_platform_facade:
            violations.append(
                f"{browser_platform_facade_path.relative_to(ROOT)} does not declare {module}"
            )
        if f"pub use {module}::" not in browser_platform_facade:
            violations.append(
                f"{browser_platform_facade_path.relative_to(ROOT)} does not re-export {module}"
            )
    for marker in BROWSER_PLATFORM_FACADE_FORBIDDEN_IMPLEMENTATION_MARKERS:
        if marker in browser_platform_facade:
            violations.append(
                f"{browser_platform_facade_path.relative_to(ROOT)} contains implementation "
                f"marker {marker}"
            )

    transfer_event_facade_path = WEB_SOURCE / "rtc_transfer_events.rs"
    transfer_event_facade = transfer_event_facade_path.read_text(encoding="utf-8")
    transfer_event_facade_lines = len(transfer_event_facade.splitlines())
    if transfer_event_facade_lines > TRANSFER_EVENT_FACADE_MAX_LINES:
        violations.append(
            f"{transfer_event_facade_path.relative_to(ROOT)} has "
            f"{transfer_event_facade_lines} lines; facade limit is "
            f"{TRANSFER_EVENT_FACADE_MAX_LINES}"
        )
    if "mod transition;" not in transfer_event_facade:
        violations.append(
            f"{transfer_event_facade_path.relative_to(ROOT)} does not declare transition"
        )
    if "match event" in transfer_event_facade:
        violations.append(
            f"{transfer_event_facade_path.relative_to(ROOT)} contains event state transitions"
        )
    transition_source = WEB_SOURCE / "rtc_transfer_events" / "transition"
    for module in TRANSFER_EVENT_TRANSITION_MODULES:
        module_path = transition_source / f"{module}.rs"
        if not module_path.is_file():
            violations.append(f"{module_path.relative_to(ROOT)} is missing")

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
        f"checked {len(FORBIDDEN_DEPENDENCIES)} web module boundaries, the browser-platform "
        "facade, and the shared UI boundary."
    )


if __name__ == "__main__":
    main()
