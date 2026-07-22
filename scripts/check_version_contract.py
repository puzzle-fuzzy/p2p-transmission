#!/usr/bin/env python3
"""Keep protocol, browser persistence and upgrade contracts in sync."""

from __future__ import annotations

from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
VERSION_SOURCE = ROOT / "rust/crates/protocol/src/version.rs"


def require(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def main() -> None:
    failures: list[str] = []
    version_source = VERSION_SOURCE.read_text(encoding="utf-8")
    identity = re.search(r"protocol_identity!\((\d+),\s*(\d+)\);", version_source)
    require(identity is not None, "protocol_identity! declaration is missing", failures)
    if identity is None:
        raise SystemExit("version contract check failed:\n- " + "\n- ".join(failures))

    major, minor = identity.groups()
    protocol = f"{major}.{minor}"
    cookie = f"p2p_session_v{major}"
    room_storage = f"p2p_room_session_v{major}"

    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    rust_readme = (ROOT / "rust/README.md").read_text(encoding="utf-8")
    release_manual = (ROOT / "docs/release/RELEASE.md").read_text(encoding="utf-8")
    http_api = (ROOT / "rust/apps/server/src/http_api.rs").read_text(encoding="utf-8")
    session_storage = (
        ROOT / "rust/crates/browser-platform/src/session_storage.rs"
    ).read_text(encoding="utf-8")
    restore_asset = (ROOT / "rust/apps/server/assets/room-restore.js").read_text(
        encoding="utf-8"
    )
    server = (ROOT / "rust/apps/server/src/lib.rs").read_text(encoding="utf-8")
    protocol_source = (ROOT / "rust/crates/protocol/src/lib.rs").read_text(encoding="utf-8")
    browser_api = (
        ROOT / "rust/crates/browser-platform/src/api.rs"
    ).read_text(encoding="utf-8")
    app_shell = (ROOT / "rust/apps/server/assets/app-shell.js").read_text(
        encoding="utf-8"
    )
    app_runtime = (ROOT / "rust/apps/web/src/app_runtime.rs").read_text(
        encoding="utf-8"
    )

    require(
        f"协议固定为 `{protocol}`" in readme,
        f"README.md must name protocol {protocol}",
        failures,
    )
    require(
        f"当前协议固定为 {protocol}" in rust_readme,
        f"rust/README.md must name protocol {protocol}",
        failures,
    )
    require(
        f"协议固定为 `{protocol}`" in release_manual,
        f"docs/release/RELEASE.md must name protocol {protocol}",
        failures,
    )
    require(
        cookie in rust_readme and room_storage in rust_readme,
        "rust/README.md must name the derived persistence identities",
        failures,
    )
    require(
        "pub const SESSION_COOKIE_NAME" not in http_api
        and "SESSION_COOKIE_NAME" in http_api,
        "server must import the protocol-owned session cookie name",
        failures,
    )
    require(
        "use p2p_protocol::ROOM_SESSION_STORAGE_KEY;" in session_storage,
        "browser session storage must import the protocol-owned key",
        failures,
    )
    require(
        restore_asset.count("__P2P_ROOM_SESSION_STORAGE_KEY__") == 1
        and room_storage not in restore_asset,
        "room restore asset must use only the storage-key placeholder",
        failures,
    )
    require(
        '"__P2P_ROOM_SESSION_STORAGE_KEY__"' in server
        and "p2p_protocol::ROOM_SESSION_STORAGE_KEY" in server,
        "server must inject the protocol-owned room storage key",
        failures,
    )
    require(
        "controllerchange" in app_shell and "p2p-app-update" in app_shell,
        "application shell must surface service-worker updates",
        failures,
    )
    require(
        "app-upgrade-dialog" in app_shell
        and "data-p2p-upgrade" in app_shell
        and "showUpgradePrompt" in app_shell,
        "application shell must own the update prompt outside the WASM island",
        failures,
    )
    require(
        'set_document_attribute("data-p2p-upgrade", "true")' in app_runtime,
        "AppEffect must bridge protocol upgrades to the shell prompt",
        failures,
    )
    require(
        "pub const CURRENT_CAPABILITIES" in protocol_source,
        "protocol crate must own the current capability set",
        failures,
    )
    require(
        "capabilities: p2p_protocol::CURRENT_CAPABILITIES" in server,
        "server metadata must advertise the protocol-owned capability set",
        failures,
    )
    require(
        "validate_build_info(info)" in browser_api
        and "CURRENT_CAPABILITIES" in browser_api
        and "missing_capabilities()" in browser_api,
        "browser bootstrap must reject incomplete server capabilities",
        failures,
    )

    if failures:
        raise SystemExit("version contract check failed:\n- " + "\n- ".join(failures))
    print(
        "Version contract check passed: "
        f"protocol={protocol}, cookie={cookie}, room_storage={room_storage}"
    )


if __name__ == "__main__":
    main()
