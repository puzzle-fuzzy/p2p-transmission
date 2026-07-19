"""Deterministic integrity manifest for the installed control-plane bundle."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import stat
from pathlib import Path
from typing import Optional


MANIFEST_SCHEMA = 1
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
PACKAGE_NAME = "deploy_control_plane"
VERSIONS_DIRECTORY_NAME = "control-plane-versions"
CURRENT_POINTER_NAME = "current"
ENTRYPOINT_NAME = "deploy-release.py"
MANAGED_MODULES = (
    "__init__.py",
    "artifacts.py",
    "capacity.py",
    "cli.py",
    "common.py",
    "database.py",
    "docker_archive.py",
    "manifest.py",
    "oci_archive.py",
    "offsite_backup.py",
    "release_state.py",
    "runtime.py",
)
MANAGED_FILES = (
    ENTRYPOINT_NAME,
    *(f"{PACKAGE_NAME}/{name}" for name in MANAGED_MODULES),
)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    except OSError as error:
        raise SystemExit(f"cannot hash deployment control-plane file {path}: {error}") from error
    return digest.hexdigest()


def control_plane_manifest(helper_root: Path) -> dict[str, object]:
    """Hash one immutable entry point and every importable module beside it."""

    root = helper_root.resolve(strict=True)
    package = root / PACKAGE_NAME
    try:
        python_modules = {
            entry.name for entry in package.iterdir() if entry.name.endswith(".py")
        }
    except OSError as error:
        raise SystemExit(f"cannot inspect deployment control-plane package: {error}") from error
    if python_modules != set(MANAGED_MODULES):
        raise SystemExit("deployment control-plane manifest omits or includes an unknown module")
    files: list[dict[str, str]] = []
    for relative in MANAGED_FILES:
        path = root / Path(relative)
        try:
            metadata = path.lstat()
        except OSError as error:
            raise SystemExit(f"deployment control-plane file is unavailable: {path}: {error}") from error
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise SystemExit(f"deployment control-plane file is unsafe: {path}")
        files.append({"path": relative, "sha256": _sha256_file(path)})
    return {"schema": MANIFEST_SCHEMA, "files": files}


def canonical_manifest_bytes(manifest: dict[str, object]) -> bytes:
    return (json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )


def control_plane_manifest_sha256(helper_root: Path) -> str:
    return hashlib.sha256(canonical_manifest_bytes(control_plane_manifest(helper_root))).hexdigest()


def _required_root_uid(metadata: os.stat_result) -> int:
    # Windows unit tests do not expose a Unix root uid. Production is Linux and
    # every privileged control-plane inode must be owned by uid 0, regardless
    # of which effective uid happens to inspect it.
    return metadata.st_uid if os.name == "nt" else 0


def _require_root_directory(path: Path, mode: int) -> Path:
    try:
        metadata = path.lstat()
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise SystemExit(f"deployment control-plane directory is unavailable: {path}: {error}") from error
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
        or (
            os.name != "nt"
            and (
                metadata.st_uid != _required_root_uid(metadata)
                or stat.S_IMODE(metadata.st_mode) != mode
            )
        )
    ):
        raise SystemExit(f"deployment control-plane directory ownership or mode is unsafe: {path}")
    return resolved


def _require_root_file(path: Path, mode: int) -> None:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor: Optional[int] = None
    try:
        path_metadata = path.lstat()
        descriptor = os.open(path, flags)
        opened_metadata = os.fstat(descriptor)
    except OSError as error:
        raise SystemExit(f"cannot inspect deployment control-plane file {path}: {error}") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
    if (
        stat.S_ISLNK(path_metadata.st_mode)
        or not stat.S_ISREG(path_metadata.st_mode)
        or not stat.S_ISREG(opened_metadata.st_mode)
        or path_metadata.st_dev != opened_metadata.st_dev
        or path_metadata.st_ino != opened_metadata.st_ino
        or opened_metadata.st_nlink != 1
        or (
            os.name != "nt"
            and (
                opened_metadata.st_uid != _required_root_uid(opened_metadata)
                or stat.S_IMODE(opened_metadata.st_mode) != mode
            )
        )
    ):
        raise SystemExit(f"deployment control-plane file ownership or mode is unsafe: {path}")


def validate_installed_control_plane(
    configured_helper: Path,
    running_helper: Path,
    running_package: Path,
    expected_sha256: str,
) -> tuple[str, dict[str, object]]:
    """Validate the immutable entry and modules selected by one pointer."""

    if not SHA256_RE.fullmatch(expected_sha256):
        raise SystemExit("expected control-plane SHA-256 must be 64 lowercase hex characters")
    if (
        not configured_helper.is_absolute()
        or configured_helper.name != ENTRYPOINT_NAME
        or configured_helper.parent.name != CURRENT_POINTER_NAME
    ):
        raise SystemExit("configured deployment control-plane path is not the fixed current entry")

    current_pointer = configured_helper.parent
    install_root = current_pointer.parent
    _require_root_directory(install_root, 0o755)
    versions_root = install_root / VERSIONS_DIRECTORY_NAME
    resolved_versions_root = _require_root_directory(versions_root, 0o555)

    try:
        pointer_metadata = current_pointer.lstat()
        resolved_version = current_pointer.resolve(strict=True)
    except OSError as error:
        raise SystemExit(f"cannot resolve the installed control-plane pointer: {error}") from error
    if (
        not stat.S_ISLNK(pointer_metadata.st_mode)
        or pointer_metadata.st_nlink != 1
        or (
            os.name != "nt"
            and pointer_metadata.st_uid != _required_root_uid(pointer_metadata)
        )
    ):
        raise SystemExit("installed control-plane current pointer is unsafe")
    if (
        resolved_version.parent != resolved_versions_root
        or not SHA256_RE.fullmatch(resolved_version.name)
    ):
        raise SystemExit("installed control-plane pointer escaped its version directory")
    expected_pointer_target = f"{VERSIONS_DIRECTORY_NAME}/{resolved_version.name}"
    try:
        pointer_target = os.readlink(current_pointer)
    except OSError as error:
        raise SystemExit(f"cannot read the installed control-plane pointer: {error}") from error
    if pointer_target != expected_pointer_target:
        raise SystemExit("installed control-plane pointer target is not canonical")

    _require_root_directory(resolved_version, 0o555)
    try:
        version_entries = {entry.name for entry in resolved_version.iterdir()}
    except OSError as error:
        raise SystemExit(f"cannot inspect installed control-plane version: {error}") from error
    if version_entries != {ENTRYPOINT_NAME, PACKAGE_NAME}:
        raise SystemExit("installed control-plane version contains unexpected or missing entries")

    physical_helper = resolved_version / ENTRYPOINT_NAME
    _require_root_file(physical_helper, 0o444)
    try:
        fixed_helper = configured_helper.resolve(strict=True)
        actual_running = running_helper.resolve(strict=True)
    except OSError as error:
        raise SystemExit(f"cannot resolve the fixed deployment control plane: {error}") from error
    if fixed_helper != physical_helper or actual_running != physical_helper:
        raise SystemExit("deployment control plane is not running from the fixed root-owned path")

    resolved_package = resolved_version / PACKAGE_NAME
    try:
        imported_package = running_package.resolve(strict=True)
    except OSError as error:
        raise SystemExit(f"cannot resolve the running control-plane package: {error}") from error
    if imported_package != resolved_package:
        raise SystemExit("running control-plane modules do not match the installed package pointer")

    _require_root_directory(resolved_package, 0o555)
    expected_entries = set(MANAGED_MODULES)
    try:
        actual_entries = {entry.name for entry in resolved_package.iterdir()}
    except OSError as error:
        raise SystemExit(f"cannot inspect installed control-plane package: {error}") from error
    if actual_entries != expected_entries:
        raise SystemExit("installed control-plane package contains unexpected or missing entries")
    for name in MANAGED_MODULES:
        module = resolved_package / name
        _require_root_file(module, 0o444)
        if module.resolve(strict=True).parent != resolved_package:
            raise SystemExit(f"installed control-plane module escaped its package: {module}")

    manifest = control_plane_manifest(resolved_version)
    actual_sha256 = hashlib.sha256(canonical_manifest_bytes(manifest)).hexdigest()
    if actual_sha256 != resolved_version.name:
        raise SystemExit("installed control-plane version does not match its manifest")
    if not hmac.compare_digest(actual_sha256, expected_sha256):
        raise SystemExit("fixed deployment control plane does not match this release")
    return actual_sha256, manifest
