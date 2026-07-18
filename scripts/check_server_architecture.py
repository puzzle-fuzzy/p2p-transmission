#!/usr/bin/env python3
"""Guard the server boundaries that keep realtime transport and commands separate."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOCKET = ROOT / "rust/apps/server/src/realtime/socket.rs"
COMMANDS = ROOT / "rust/apps/server/src/realtime/socket/commands.rs"
COMMAND_ERRORS = ROOT / "rust/apps/server/src/realtime/socket/commands/errors.rs"


def production_source(path: Path) -> str:
    return path.read_text(encoding="utf-8").split("#[cfg(test)]", 1)[0]


def main() -> None:
    failures: list[str] = []
    socket = production_source(SOCKET)
    commands = production_source(COMMANDS)
    command_errors = production_source(COMMAND_ERRORS)

    if len(socket.splitlines()) > 300:
        failures.append("realtime/socket.rs production code must stay at or below 300 lines")
    if len(commands.splitlines()) > 400:
        failures.append("realtime/socket/commands.rs must stay at or below 400 lines")
    if len(command_errors.splitlines()) > 200:
        failures.append("realtime/socket/commands/errors.rs must stay at or below 200 lines")
    if "mod commands;" not in socket:
        failures.append("realtime socket must declare its command boundary")
    if "async fn handle_client_message" in socket:
        failures.append("WebSocket lifecycle must not implement command dispatch")
    if "pub(super) async fn handle_client_message" not in commands:
        failures.append("command module must expose the internal dispatcher")
    if "mod errors;" not in commands:
        failures.append("command dispatch must keep error classification in its own module")

    for helper in (
        "async fn attach_room",
        "async fn watch_join_request",
        "async fn detach_room",
        "async fn relay_signal",
        "async fn authorize_signal",
    ):
        if helper not in commands:
            failures.append(f"command module is missing its {helper.removeprefix('async fn ')} boundary")

    if failures:
        details = "\n".join(f"- {failure}" for failure in failures)
        raise SystemExit(f"server architecture check failed:\n{details}")

    print(
        "Server architecture check passed: WebSocket lifecycle, command dispatch, "
        "authorization, and signaling boundaries are separated."
    )


if __name__ == "__main__":
    main()
