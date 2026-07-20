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
RTC_BROWSER_SOURCE = BROWSER_PLATFORM_SOURCE / "rtc" / "browser"
RTC_BROWSER_FILE_CAPABILITY_MODULE = RTC_BROWSER_SOURCE / "files.rs"
RTC_BROWSER_FILE_CAPABILITY_REQUIRED_MARKERS = (
    "pub struct BrowserFile",
    "pub fn browser_files_from_input",
    "pub fn persistent_source_file_support",
    "pub async fn choose_persistent_source_files",
    "HtmlInputElement",
    "choose_source_files",
)
RTC_BROWSER_MOD_FORBIDDEN_FILE_CAPABILITY_PATTERNS = (
    r"\bpub\s+struct\s+BrowserFile\b",
    r"\bpub\s+fn\s+browser_files_from_input\b",
    r"\bpub\s+fn\s+persistent_source_file_support\b",
    r"\bpub\s+async\s+fn\s+choose_persistent_source_files\b",
    r"\bHtmlInputElement\b",
    r"\bchoose_source_files\b",
)
RTC_BROWSER_CONNECTION_MODULE = RTC_BROWSER_SOURCE / "connection.rs"
RTC_BROWSER_CONNECTION_REQUIRED_MARKERS = (
    "pub(super) fn rtc_configuration",
    "pub(super) fn map_connection_state",
    "pub(super) fn local_description_sdp",
    "RtcConfiguration",
    "RtcPeerConnection",
    "RtcPeerConnectionState",
    "peer_connection.local_description()",
)
RTC_BROWSER_MOD_FORBIDDEN_CONNECTION_PATTERNS = (
    r"\bfn\s+rtc_configuration\b",
    r"\bfn\s+map_connection_state\b",
    r"\bfn\s+local_description_sdp\b",
)
RTC_BROWSER_FACADE_MAX_LINES = 80
RTC_BROWSER_RESPONSIBILITY_MODULES = ("peer", "signaling", "lifecycle", "recovery")
RTC_BROWSER_FACADE_FORBIDDEN_IMPLEMENTATION_PATTERNS = (
    r"\bstruct\s+Inner\b",
    r"\bimpl\s+RtcPeer\b",
    r"\bfn\s+prepare_outgoing\b",
    r"\bfn\s+ensure_peer_connection\b",
)
RTC_BROWSER_THIN_FACADES = {
    Path("mod.rs"): 80,
    Path("lifecycle/mod.rs"): 24,
    Path("recovery/mod.rs"): 24,
}
RTC_BROWSER_RESPONSIBILITY_MARKERS = {
    Path("peer.rs"): (
        "pub struct RtcPeer",
        "struct Inner",
        "pub fn new",
        "fn clear_peer_resources",
    ),
    Path("signaling.rs"): (
        "pub fn start_offer",
        "pub fn accept_signal",
        "fn ensure_peer_connection",
        "fn install_data_channel",
    ),
    Path("lifecycle/commands.rs"): (
        "pub fn offer_files",
        "pub async fn cancel_transfer",
        "fn install_and_offer_outgoing",
    ),
    Path("lifecycle/events.rs"): (
        "fn handle_decision",
        "fn handle_stream_complete",
        "fn clear_transfer",
    ),
    Path("lifecycle/reconnect.rs"): (
        "pub fn reset",
        "pub fn prepare_reconnect",
        "fn suspend_stream_for_reconnect",
    ),
    Path("lifecycle/manifest.rs"): (
        "fn active_transfer_id",
        "fn prepare_outgoing",
    ),
    Path("recovery/outgoing.rs"): (
        "pub async fn offer_persistent_files",
        "pub async fn restore_outgoing_transfer",
        "fn handle_stream_ready",
        "fn restore_outgoing_recovery",
    ),
    Path("recovery/incoming.rs"): (
        "pub async fn accept_stream_transfer",
        "pub async fn resume_stream_transfer",
        "fn handle_manifest",
        "fn restore_stream_recovery",
    ),
}
RTC_BROWSER_REMOVED_MONOLITHS = (
    RTC_BROWSER_SOURCE / "lifecycle.rs",
    RTC_BROWSER_SOURCE / "recovery.rs",
)
TRANSFER_EVENT_FACADE_MAX_LINES = 80
TRANSFER_EVENT_TRANSITION_MODULES = ("offer", "pause", "progress", "terminal")
TRANSFER_PANEL_FACADE_MAX_LINES = 220
TRANSFER_PANEL_RESPONSIBILITY_MODULES = (
    "file_progress_list",
    "receiver_transfer_list",
    "transfer_action_area",
    "view_model",
)
TRANSFER_PANEL_VIEW_MODEL_FORBIDDEN_MARKERS = (
    "dioxus::",
    "wasm_bindgen::",
    "web_sys::",
    "Signal<",
    "rsx!",
)


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

    rtc_browser_mod_path = RTC_BROWSER_SOURCE / "mod.rs"
    rtc_browser_mod = rtc_browser_mod_path.read_text(encoding="utf-8")
    if "mod files;" not in rtc_browser_mod:
        violations.append(
            f"{rtc_browser_mod_path.relative_to(ROOT)} does not declare files"
        )
    if not re.search(r"\bpub\s+use\s+files::\{", rtc_browser_mod):
        violations.append(
            f"{rtc_browser_mod_path.relative_to(ROOT)} does not re-export files"
        )
    for pattern in RTC_BROWSER_MOD_FORBIDDEN_FILE_CAPABILITY_PATTERNS:
        if re.search(pattern, rtc_browser_mod):
            violations.append(
                f"{rtc_browser_mod_path.relative_to(ROOT)} contains file capability "
                f"implementation matching {pattern}"
            )
    if "mod connection;" not in rtc_browser_mod:
        violations.append(
            f"{rtc_browser_mod_path.relative_to(ROOT)} does not declare connection"
        )
    for pattern in RTC_BROWSER_MOD_FORBIDDEN_CONNECTION_PATTERNS:
        if re.search(pattern, rtc_browser_mod):
            violations.append(
                f"{rtc_browser_mod_path.relative_to(ROOT)} contains connection setup "
                f"implementation matching {pattern}"
            )

    if not RTC_BROWSER_FILE_CAPABILITY_MODULE.is_file():
        violations.append(
            f"{RTC_BROWSER_FILE_CAPABILITY_MODULE.relative_to(ROOT)} is missing"
        )
    else:
        rtc_browser_files = RTC_BROWSER_FILE_CAPABILITY_MODULE.read_text(encoding="utf-8")
        for marker in RTC_BROWSER_FILE_CAPABILITY_REQUIRED_MARKERS:
            if marker not in rtc_browser_files:
                violations.append(
                    f"{RTC_BROWSER_FILE_CAPABILITY_MODULE.relative_to(ROOT)} does not own "
                    f"required file capability marker {marker}"
                )

    if not RTC_BROWSER_CONNECTION_MODULE.is_file():
        violations.append(
            f"{RTC_BROWSER_CONNECTION_MODULE.relative_to(ROOT)} is missing"
        )
    else:
        rtc_browser_connection = RTC_BROWSER_CONNECTION_MODULE.read_text(encoding="utf-8")
        for marker in RTC_BROWSER_CONNECTION_REQUIRED_MARKERS:
            if marker not in rtc_browser_connection:
                violations.append(
                    f"{RTC_BROWSER_CONNECTION_MODULE.relative_to(ROOT)} does not own "
                    f"required connection marker {marker}"
                )

    rtc_browser_facade_lines = len(rtc_browser_mod.splitlines())
    if rtc_browser_facade_lines > RTC_BROWSER_FACADE_MAX_LINES:
        violations.append(
            f"{rtc_browser_mod_path.relative_to(ROOT)} has {rtc_browser_facade_lines} lines; "
            f"RTC facade limit is {RTC_BROWSER_FACADE_MAX_LINES}"
        )
    for module in RTC_BROWSER_RESPONSIBILITY_MODULES:
        if f"mod {module};" not in rtc_browser_mod:
            violations.append(
                f"{rtc_browser_mod_path.relative_to(ROOT)} does not declare {module}"
            )
    for pattern in RTC_BROWSER_FACADE_FORBIDDEN_IMPLEMENTATION_PATTERNS:
        if re.search(pattern, rtc_browser_mod):
            violations.append(
                f"{rtc_browser_mod_path.relative_to(ROOT)} contains RTC implementation "
                f"matching {pattern}"
            )

    for relative_path, max_lines in RTC_BROWSER_THIN_FACADES.items():
        path = RTC_BROWSER_SOURCE / relative_path
        if not path.is_file():
            violations.append(f"{path.relative_to(ROOT)} is missing")
            continue
        line_count = len(path.read_text(encoding="utf-8").splitlines())
        if line_count > max_lines:
            violations.append(
                f"{path.relative_to(ROOT)} has {line_count} lines; "
                f"thin facade limit is {max_lines}"
            )

    for relative_path, markers in RTC_BROWSER_RESPONSIBILITY_MARKERS.items():
        path = RTC_BROWSER_SOURCE / relative_path
        if not path.is_file():
            violations.append(f"{path.relative_to(ROOT)} is missing")
            continue
        source = path.read_text(encoding="utf-8")
        for marker in markers:
            if marker not in source:
                violations.append(
                    f"{path.relative_to(ROOT)} does not own required RTC marker {marker}"
                )

    for path in RTC_BROWSER_REMOVED_MONOLITHS:
        if path.exists():
            violations.append(
                f"{path.relative_to(ROOT)} recreates a removed RTC responsibility monolith"
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

    transfer_panel_facade_path = WEB_SOURCE / "transfer_panel.rs"
    transfer_panel_facade = transfer_panel_facade_path.read_text(encoding="utf-8")
    transfer_panel_facade_lines = len(transfer_panel_facade.splitlines())
    if transfer_panel_facade_lines > TRANSFER_PANEL_FACADE_MAX_LINES:
        violations.append(
            f"{transfer_panel_facade_path.relative_to(ROOT)} has "
            f"{transfer_panel_facade_lines} lines; facade limit is "
            f"{TRANSFER_PANEL_FACADE_MAX_LINES}"
        )
    transfer_panel_source = WEB_SOURCE / "transfer_panel"
    for module in TRANSFER_PANEL_RESPONSIBILITY_MODULES:
        module_path = transfer_panel_source / f"{module}.rs"
        if not module_path.is_file():
            violations.append(f"{module_path.relative_to(ROOT)} is missing")
        if f"mod {module};" not in transfer_panel_facade:
            violations.append(
                f"{transfer_panel_facade_path.relative_to(ROOT)} does not declare {module}"
            )
    transfer_panel_view_model_path = transfer_panel_source / "view_model.rs"
    if transfer_panel_view_model_path.is_file():
        transfer_panel_view_model = transfer_panel_view_model_path.read_text(
            encoding="utf-8"
        )
        for marker in TRANSFER_PANEL_VIEW_MODEL_FORBIDDEN_MARKERS:
            if marker in transfer_panel_view_model:
                violations.append(
                    f"{transfer_panel_view_model_path.relative_to(ROOT)} contains UI/runtime "
                    f"marker {marker}"
                )

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
        "facade, the RTC file, connection, peer/signaling, transfer-lifecycle, and "
        "recovery boundaries, the transfer-panel facade/view-model split, and the shared "
        "UI boundary."
    )


if __name__ == "__main__":
    main()
