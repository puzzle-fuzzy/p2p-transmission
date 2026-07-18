"""Privileged deployment orchestration and command-line entry point."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Optional

from . import artifacts, capacity, manifest, release_state, runtime
from .common import (
    CONTROL_PLANE_HELPER,
    IMAGE_ARCHIVE_RE,
    SOURCE_ARCHIVE_RE,
    VERSION_RE,
)


def deploy(
    archive: Path,
    version: str,
    image_archive: Path,
) -> None:
    if not VERSION_RE.fullmatch(version):
        raise SystemExit("release version contains unsupported characters")
    uploaded_archive = archive
    uploaded_image = image_archive
    snapshot: Optional[artifacts.ReleaseArtifactSnapshot] = None
    try:
        release_state.ensure_no_pending_release()
        snapshot = artifacts.snapshot_release_artifacts(
            archive,
            image_archive,
        )
        archive = artifacts.validate_source_archive(
            snapshot.source_archive,
            trusted_root=snapshot.root,
        )
        image = artifacts.validate_image_archive(
            snapshot.image_archive,
            trusted_root=snapshot.root,
        )
        current_files = artifacts.source_archive_files(archive)
        artifacts.read_source_manifest()
        capacity.require_stage_disk_capacity(archive, image)
        preflight = runtime.preflight_production(image, version)
        try:
            artifacts.extract_archive(archive)
            artifacts.remove_retired_source_files(current_files)
            artifacts.write_source_manifest(current_files)
        except BaseException as source_error:
            compose_restored = runtime.restore_compose(preflight.compose_snapshot)
            snapshots_cleaned = preflight.cleanup_snapshots()
            if not compose_restored or not snapshots_cleaned:
                raise SystemExit(
                    "source release failed and its rollback files could not be fully reconciled"
                ) from source_error
            raise
        runtime.deploy_production(preflight, version)
    finally:
        try:
            if snapshot is not None:
                snapshot.cleanup()
        finally:
            artifacts.remove_uploaded_artifact(uploaded_archive, SOURCE_ARCHIVE_RE)
            artifacts.remove_uploaded_artifact(uploaded_image, IMAGE_ARCHIVE_RE)


def source_control_plane_manifest(
    helper_root: Path,
    output_format: str = "sha256",
) -> str:
    bundle_manifest = manifest.control_plane_manifest(helper_root)
    digest = hashlib.sha256(manifest.canonical_manifest_bytes(bundle_manifest)).hexdigest()
    if output_format == "sha256":
        return digest
    if output_format == "json":
        return json.dumps(
            {"control_plane_sha256": digest, "manifest": bundle_manifest},
            sort_keys=True,
            separators=(",", ":"),
        )
    raise SystemExit("unsupported control-plane manifest output format")


def report_control_plane_status(
    expected_sha256: str,
    *,
    running_helper: Optional[Path] = None,
    configured_helper: Optional[Path] = None,
) -> None:
    actual, bundle_manifest = validate_running_control_plane(
        expected_sha256,
        running_helper=running_helper,
        configured_helper=configured_helper,
    )
    print(
        json.dumps(
            {
                "control_plane_sha256": actual,
                "files": bundle_manifest["files"],
                "status": "ready",
            },
            sort_keys=True,
        ),
        flush=True,
    )


def validate_running_control_plane(
    expected_sha256: str,
    *,
    running_helper: Optional[Path] = None,
    configured_helper: Optional[Path] = None,
) -> tuple[str, dict[str, object]]:
    """Bind an operation to the immutable control-plane bundle selected now."""

    configured = CONTROL_PLANE_HELPER if configured_helper is None else configured_helper
    running = Path(sys.argv[0]) if running_helper is None else running_helper
    return manifest.validate_installed_control_plane(
        configured,
        running,
        Path(__file__).resolve(strict=True).parent,
        expected_sha256,
    )


def imported_control_plane_sha256() -> str:
    """Return the digest-named immutable version that supplied this CLI module."""

    return Path(__file__).resolve(strict=True).parent.parent.name


def main() -> int:
    parser = argparse.ArgumentParser()
    actions = parser.add_subparsers(dest="action", required=True)
    stage = actions.add_parser("stage", help="switch production and retain rollback state")
    stage.add_argument("--archive", required=True, type=Path)
    stage.add_argument("--version", required=True)
    stage.add_argument("--image-archive", required=True, type=Path)
    stage.add_argument("--expected-control-plane-sha256", required=True)
    finalize = actions.add_parser("finalize", help="accept a publicly verified release")
    finalize.add_argument("--version", required=True)
    rollback = actions.add_parser("rollback", help="restore the release staged previously")
    rollback.add_argument("--version", required=True)
    actions.add_parser(
        "maintenance",
        help="check production and verify a recent SQLite backup can be restored",
    )
    control_plane = actions.add_parser(
        "control-plane-status",
        help="prove the fixed root-owned helper bundle matches the release workflow",
    )
    control_plane.add_argument("--expected-sha256", required=True)
    bundle_manifest = actions.add_parser(
        "control-plane-manifest",
        help="print the deterministic source control-plane manifest",
    )
    bundle_manifest.add_argument("--format", choices=("sha256", "json"), default="sha256")
    args = parser.parse_args()

    if args.action == "control-plane-manifest":
        helper_root = Path(sys.argv[0]).resolve(strict=True).parent
        print(source_control_plane_manifest(helper_root, args.format), flush=True)
        return 0
    with release_state.production_control_plane_lock():
        if args.action == "control-plane-status":
            report_control_plane_status(args.expected_sha256)
            return 0
        if args.action == "stage":
            validate_running_control_plane(args.expected_control_plane_sha256)
        else:
            # Even operations without a workflow-provided digest must never run
            # from a version that was superseded while Python was importing it.
            validate_running_control_plane(imported_control_plane_sha256())
        release_state.cleanup_abandoned_release_artifacts()
        release_state.cleanup_abandoned_runtime_snapshots()
        if args.action == "stage":
            deploy(args.archive, args.version, args.image_archive)
        elif args.action == "finalize":
            runtime.finalize_pending_release(args.version)
        elif args.action == "rollback":
            runtime.rollback_pending_release(args.version)
        else:
            runtime.maintain_production()
    return 0
