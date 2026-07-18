#!/usr/bin/env python3
"""Validate the checked-in coturn Compose model and relay policy example."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import TypeAlias


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_COMPOSE = ROOT / "deploy" / "coturn" / "compose.yml"
DEFAULT_TURN_CONFIG = ROOT / "deploy" / "coturn" / "turnserver.conf.example"
TURN_CONFIG_TARGET = "/etc/coturn/turnserver.conf"

PINNED_COTURN_IMAGE = re.compile(
    r"coturn/coturn:[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9]+)*"
)
REQUIRED_VOLUME_SOURCES = {
    TURN_CONFIG_TARGET: "/.local/turnserver.conf",
    "/run/coturn/tls/fullchain.pem": "/.local/tls/fullchain.pem",
    "/run/coturn/tls/privkey.pem": "/.local/tls/privkey.pem",
}
REQUIRED_FLAGS = {
    "fingerprint",
    "no-cli",
    "no-loopback-peers",
    "no-multicast-peers",
    "no-tlsv1",
    "no-tlsv1_1",
    "use-auth-secret",
}
REQUIRED_VALUES = {
    "cert": "/run/coturn/tls/fullchain.pem",
    "external-ip": "203.0.113.10",
    "listening-port": "3478",
    "max-port": "49259",
    "min-port": "49160",
    "pkey": "/run/coturn/tls/privkey.pem",
    "realm": "turn.example.com",
    "tls-listening-port": "5349",
}
REQUIRED_DENIED_PEER_RANGES = {
    "0.0.0.0-0.255.255.255",
    "10.0.0.0-10.255.255.255",
    "127.0.0.0-127.255.255.255",
    "169.254.0.0-169.254.255.255",
    "172.16.0.0-172.31.255.255",
    "192.168.0.0-192.168.255.255",
    "224.0.0.0-255.255.255.255",
    "fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "ff00::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
}
SELF_RELAY_ALLOW_PLACEHOLDER = (
    "# allowed-peer-ip=<TURN_PRIVATE_IP>-<TURN_PRIVATE_IP>"
)
FORBIDDEN_DIRECTIVES = {
    "lt-cred-mech",
    "no-dtls",
    "no-tls",
    "oauth",
    "user",
}

DirectiveMap: TypeAlias = dict[str, list[str | None]]


class ConfigurationError(RuntimeError):
    """Raised when Docker Compose cannot normalize the checked-in model."""


def load_compose_model(compose_file: Path) -> dict[str, object]:
    command = [
        "docker",
        "compose",
        "-f",
        str(compose_file),
        "config",
        "--format",
        "json",
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as error:
        raise ConfigurationError("docker compose is required for the TURN gate") from error
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise ConfigurationError(f"docker compose config failed: {detail}")
    try:
        model = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise ConfigurationError("docker compose config did not return valid JSON") from error
    if not isinstance(model, dict):
        raise ConfigurationError("docker compose config must return a JSON object")
    return model


def _named_yaml_block(
    lines: list[tuple[int, str]],
    start: int,
    end: int,
    name: str,
) -> tuple[int, int] | None:
    """Locate a direct mapping child in the small, checked-in Compose subset."""
    if start >= end:
        return None
    direct_indent = min(indent for indent, _ in lines[start:end])
    matches = [
        index
        for index in range(start, end)
        if lines[index] == (direct_indent, f"{name}:")
    ]
    if len(matches) != 1:
        return None
    key_index = matches[0]
    block_end = next(
        (
            index
            for index in range(key_index + 1, end)
            if lines[index][0] <= direct_indent
        ),
        end,
    )
    return key_index + 1, block_end


def validate_compose_source(text: str) -> list[str]:
    """Require fail-closed bind options from source YAML.

    Some Compose releases omit an explicit boolean ``false`` while serializing
    the config model. Compose still validates the full model; this narrow source
    pass independently proves that each protected coturn mount opts out of
    automatic host-path creation.
    """
    if "\t" in text:
        return ["Compose source must use spaces for indentation"]
    lines = []
    for raw_line in text.splitlines():
        content = raw_line.split("#", 1)[0].rstrip()
        if not content.strip():
            continue
        lines.append((len(content) - len(content.lstrip(" ")), content.strip()))

    block: tuple[int, int] | None = (0, len(lines))
    for name in ("services", "coturn", "volumes"):
        if block is None:
            break
        block = _named_yaml_block(lines, *block, name)
    if block is None:
        return ["Compose source must define services.coturn.volumes as a mapping list"]

    start, end = block
    if start >= end:
        return ["Compose source coturn volumes list is empty"]
    item_indent = min(indent for indent, _ in lines[start:end])
    item_starts = [
        index
        for index in range(start, end)
        if lines[index][0] == item_indent and lines[index][1].startswith("- ")
    ]
    policies: dict[str, list[bool]] = {}
    for position, item_start in enumerate(item_starts):
        item_end = item_starts[position + 1] if position + 1 < len(item_starts) else end
        first = lines[item_start][1][2:].strip()
        if first != "type: bind":
            continue
        body = lines[item_start + 1 : item_end]
        if not body:
            continue
        property_indent = min(indent for indent, _ in body)
        target_values = [
            content.removeprefix("target:").strip()
            for indent, content in body
            if indent == property_indent and content.startswith("target:")
        ]
        bind_indices = [
            index
            for index in range(item_start + 1, item_end)
            if lines[index] == (property_indent, "bind:")
        ]
        if len(target_values) != 1:
            continue
        create_values: list[str] = []
        if len(bind_indices) == 1:
            bind_index = bind_indices[0]
            bind_end = next(
                (
                    index
                    for index in range(bind_index + 1, item_end)
                    if lines[index][0] <= property_indent
                ),
                item_end,
            )
            create_values = [
                content.removeprefix("create_host_path:").strip()
                for indent, content in lines[bind_index + 1 : bind_end]
                if indent > property_indent
                and content.startswith("create_host_path:")
            ]
        policies.setdefault(target_values[0], []).append(create_values == ["false"])

    return [
        f"{target} must explicitly set bind.create_host_path to false in Compose source"
        for target in REQUIRED_VOLUME_SOURCES
        if policies.get(target) != [True]
    ]


def validate_compose_model(model: dict[str, object]) -> list[str]:
    errors: list[str] = []
    services = model.get("services")
    if not isinstance(services, dict):
        return ["Compose model does not define services"]
    service = services.get("coturn")
    if not isinstance(service, dict):
        return ["Compose model does not define the coturn service"]

    image = service.get("image")
    if not isinstance(image, str) or PINNED_COTURN_IMAGE.fullmatch(image) is None:
        errors.append("coturn image must use an explicit versioned coturn/coturn tag")
    if service.get("network_mode") != "host":
        errors.append("coturn service must use host networking for its relay range")
    if service.get("restart") != "unless-stopped":
        errors.append("coturn service must retain the unless-stopped restart policy")
    if service.get("command") != ["-c", TURN_CONFIG_TARGET]:
        errors.append("coturn service must load the mounted turnserver configuration")

    volumes = service.get("volumes")
    if not isinstance(volumes, list):
        return [*errors, "coturn service does not define long-form bind mounts"]
    volumes_by_target = {
        volume.get("target"): volume
        for volume in volumes
        if isinstance(volume, dict) and isinstance(volume.get("target"), str)
    }
    for target, source_suffix in REQUIRED_VOLUME_SOURCES.items():
        volume = volumes_by_target.get(target)
        if not isinstance(volume, dict):
            errors.append(f"coturn service is missing the {target} bind mount")
            continue
        source = volume.get("source")
        normalized_source = source.replace("\\", "/") if isinstance(source, str) else ""
        if volume.get("type") != "bind" or not normalized_source.endswith(source_suffix):
            errors.append(f"{target} must be bound from {source_suffix.removeprefix('/')}")
        if volume.get("read_only") is not True:
            errors.append(f"{target} bind mount must be read-only")
        bind = volume.get("bind")
        if (
            isinstance(bind, dict)
            and bind.get("create_host_path") is not None
            and bind.get("create_host_path") is not False
        ):
            errors.append(f"{target} must disable automatic host-path creation")
    return errors


def parse_directives(text: str) -> DirectiveMap:
    directives: DirectiveMap = {}
    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        if "=" in line:
            name, value = line.split("=", 1)
            parsed_value: str | None = value.strip()
        else:
            parts = line.split(None, 1)
            name = parts[0]
            parsed_value = parts[1].strip() if len(parts) == 2 else None
        directives.setdefault(name.strip(), []).append(parsed_value)
    return directives


def require_single_value(
    directives: DirectiveMap,
    name: str,
    expected: str,
    errors: list[str],
) -> None:
    if directives.get(name) != [expected]:
        errors.append(f"{name} must appear exactly once with value {expected}")


def positive_integer(
    directives: DirectiveMap,
    name: str,
    errors: list[str],
) -> int | None:
    values = directives.get(name, [])
    if len(values) != 1 or values[0] is None:
        errors.append(f"{name} must appear exactly once with an integer value")
        return None
    try:
        value = int(values[0])
    except ValueError:
        errors.append(f"{name} must be an integer")
        return None
    if value <= 0:
        errors.append(f"{name} must be positive")
        return None
    return value


def validate_turn_config(text: str) -> list[str]:
    errors: list[str] = []
    directives = parse_directives(text)

    for flag in sorted(REQUIRED_FLAGS):
        if directives.get(flag) != [None]:
            errors.append(f"{flag} must appear exactly once as a flag")
    for name, expected in REQUIRED_VALUES.items():
        require_single_value(directives, name, expected, errors)

    for forbidden in sorted(FORBIDDEN_DIRECTIVES):
        if forbidden in directives:
            errors.append(f"{forbidden} must not be enabled in the shared-secret relay policy")
    if "static-auth-secret" in directives:
        errors.append("the checked-in example must not contain an active TURN shared secret")
    placeholder_present = any(
        line.strip().startswith("# static-auth-secret=") for line in text.splitlines()
    )
    if not placeholder_present:
        errors.append("the checked-in example must document the static-auth-secret placeholder")
    self_relay_placeholder_present = any(
        line.strip() == SELF_RELAY_ALLOW_PLACEHOLDER for line in text.splitlines()
    )
    if not self_relay_placeholder_present:
        errors.append(
            "the checked-in example must document the exact self-relay peer exception"
        )
    if "allowed-peer-ip" in directives:
        errors.append(
            "the checked-in example must not enable an environment-specific peer exception"
        )

    denied_ranges = {
        value
        for value in directives.get("denied-peer-ip", [])
        if value is not None
    }
    for denied_range in sorted(REQUIRED_DENIED_PEER_RANGES - denied_ranges):
        errors.append(f"denied-peer-ip is missing protected range {denied_range}")

    user_quota = positive_integer(directives, "user-quota", errors)
    total_quota = positive_integer(directives, "total-quota", errors)
    max_bps = positive_integer(directives, "max-bps", errors)
    bps_capacity = positive_integer(directives, "bps-capacity", errors)
    if user_quota is not None and total_quota is not None and total_quota < user_quota:
        errors.append("total-quota must be at least user-quota")
    if max_bps is not None and bps_capacity is not None and bps_capacity < max_bps:
        errors.append("bps-capacity must be at least max-bps")
    return errors


def check(compose_file: Path, turn_config: Path) -> list[str]:
    model = load_compose_model(compose_file)
    errors = validate_compose_model(model)
    try:
        compose_text = compose_file.read_text(encoding="utf-8")
    except OSError as error:
        raise ConfigurationError(f"unable to read {compose_file}: {error}") from error
    errors.extend(validate_compose_source(compose_text))
    try:
        config_text = turn_config.read_text(encoding="utf-8")
    except OSError as error:
        raise ConfigurationError(f"unable to read {turn_config}: {error}") from error
    errors.extend(validate_turn_config(config_text))
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compose", type=Path, default=DEFAULT_COMPOSE)
    parser.add_argument("--turn-config", type=Path, default=DEFAULT_TURN_CONFIG)
    args = parser.parse_args()
    try:
        errors = check(args.compose.resolve(), args.turn_config.resolve())
    except ConfigurationError as error:
        print(f"TURN configuration check failed: {error}", file=sys.stderr)
        return 1
    if errors:
        print("TURN configuration check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print("TURN configuration check passed: Compose and relay policy are valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
