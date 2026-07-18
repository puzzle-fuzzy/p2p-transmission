"""Validate the OCI half of a modern Docker image archive."""

from __future__ import annotations

import hashlib
import json
import tarfile
from collections.abc import Mapping
from pathlib import PurePosixPath


MAX_OCI_INDEX_BYTES = 1024 * 1024
MAX_OCI_LAYOUT_BYTES = 4096
MAX_OCI_MANIFEST_BYTES = 1024 * 1024
OCI_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json"
OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json"
OCI_CONFIG_MEDIA_TYPE = "application/vnd.oci.image.config.v1+json"
OCI_LAYER_MEDIA_TYPE = "application/vnd.oci.image.layer.v1.tar"


def _json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> object:
    raise ValueError(f"non-finite JSON number: {value}")


def _read_json_member(
    archive: tarfile.TarFile,
    member: tarfile.TarInfo,
    *,
    maximum_bytes: int,
    label: str,
) -> object:
    if not member.isfile() or member.size < 0 or member.size > maximum_bytes:
        raise SystemExit(f"Docker image archive {label} is not a safe regular file")
    source = archive.extractfile(member)
    if source is None:
        raise SystemExit(f"Docker image archive {label} cannot be read")
    try:
        payload = source.read(maximum_bytes + 1)
        if len(payload) != member.size or len(payload) > maximum_bytes:
            raise SystemExit(f"Docker image archive {label} is truncated or too large")
        return json.loads(
            payload.decode("utf-8"),
            object_pairs_hook=_json_object,
            parse_constant=_reject_json_constant,
        )
    except SystemExit:
        raise
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f"Docker image archive {label} is invalid JSON: {error}") from error


def _sha256_member(archive: tarfile.TarFile, member: tarfile.TarInfo, label: str) -> str:
    if not member.isfile() or member.size < 0:
        raise SystemExit(f"Docker image archive {label} is not a safe regular file")
    source = archive.extractfile(member)
    if source is None:
        raise SystemExit(f"Docker image archive {label} cannot be read")
    digest = hashlib.sha256()
    remaining = member.size
    try:
        while remaining:
            chunk = source.read(min(1024 * 1024, remaining))
            if not chunk:
                raise SystemExit(f"Docker image archive {label} is truncated")
            remaining -= len(chunk)
            digest.update(chunk)
        if source.read(1):
            raise SystemExit(f"Docker image archive {label} exceeds its declared size")
    except SystemExit:
        raise
    except (OSError, tarfile.TarError) as error:
        raise SystemExit(f"Docker image archive {label} cannot be read: {error}") from error
    return digest.hexdigest()


def _blob_digest(name: str, label: str) -> str:
    parts = PurePosixPath(name).parts
    if (
        len(parts) != 3
        or parts[:2] != ("blobs", "sha256")
        or len(parts[2]) != 64
        or any(character not in "0123456789abcdef" for character in parts[2])
    ):
        raise SystemExit(f"Docker image archive {label} is not a canonical SHA-256 blob path")
    return parts[2]


def _descriptor(
    value: object,
    label: str,
    media_type: str,
    *,
    annotations: dict[str, str] | None = None,
) -> tuple[str, int]:
    expected_keys = {"mediaType", "digest", "size"}
    if annotations is not None:
        expected_keys.add("annotations")
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise SystemExit(f"Docker image archive {label} descriptor is invalid")
    digest = value.get("digest")
    size = value.get("size")
    if (
        value.get("mediaType") != media_type
        or not isinstance(digest, str)
        or not digest.startswith("sha256:")
        or len(digest) != 71
        or any(character not in "0123456789abcdef" for character in digest[7:])
        or isinstance(size, bool)
        or not isinstance(size, int)
        or size < 0
        or (annotations is not None and value.get("annotations") != annotations)
    ):
        raise SystemExit(f"Docker image archive {label} descriptor is invalid")
    return digest[7:], size


def _canonical_image_name(expected_image: str) -> str:
    repository, separator, _tag = expected_image.rpartition(":")
    if not separator or not repository:
        raise SystemExit(f"expected Docker image tag is invalid: {expected_image}")
    first_component = repository.partition("/")[0]
    if "/" not in repository:
        return f"docker.io/library/{expected_image}"
    if first_component == "localhost" or "." in first_component or ":" in first_component:
        return expected_image
    return f"docker.io/{expected_image}"


def validate_oci_image_layout(
    archive: tarfile.TarFile,
    members: Mapping[str, tarfile.TarInfo],
    expected_image: str,
    docker_image: Mapping[str, object],
    docker_config: object,
    config_digest: str,
    config_size: int,
    repositories_target: str,
) -> str:
    """Require matching Docker/OCI metadata and return the OCI manifest digest."""

    if set(docker_image) != {"Config", "RepoTags", "Layers", "LayerSources"}:
        raise SystemExit("Docker image archive manifest entry is ambiguous")
    fixed_members = {"blobs", "blobs/sha256", "index.json", "manifest.json", "oci-layout", "repositories"}
    blob_members: dict[str, tarfile.TarInfo] = {}
    for name, member in members.items():
        if name in fixed_members:
            continue
        digest = _blob_digest(name, "blob member")
        blob_members[digest] = member
    if set(members) != fixed_members | {f"blobs/sha256/{digest}" for digest in blob_members}:
        raise SystemExit("Docker image archive OCI layout contains unexpected members")
    if not members["blobs"].isdir() or not members["blobs/sha256"].isdir():
        raise SystemExit("Docker image archive OCI blob directories are missing or unsafe")
    for digest, member in blob_members.items():
        if _sha256_member(archive, member, f"blob sha256:{digest}") != digest:
            raise SystemExit(f"Docker image archive blob digest mismatch: sha256:{digest}")

    layout = _read_json_member(
        archive, members["oci-layout"], maximum_bytes=MAX_OCI_LAYOUT_BYTES, label="oci-layout"
    )
    if layout != {"imageLayoutVersion": "1.0.0"}:
        raise SystemExit("Docker image archive oci-layout is unsupported or invalid")

    index = _read_json_member(
        archive, members["index.json"], maximum_bytes=MAX_OCI_INDEX_BYTES, label="index.json"
    )
    if (
        not isinstance(index, dict)
        or set(index) != {"schemaVersion", "mediaType", "manifests"}
        or index.get("schemaVersion") != 2
        or index.get("mediaType") != OCI_INDEX_MEDIA_TYPE
        or not isinstance(index.get("manifests"), list)
        or len(index["manifests"]) != 1
    ):
        raise SystemExit("Docker image archive OCI index must contain exactly one image")
    _repository, _separator, tag = expected_image.rpartition(":")
    manifest_digest, manifest_size = _descriptor(
        index["manifests"][0],
        "OCI index manifest",
        OCI_MANIFEST_MEDIA_TYPE,
        annotations={
            "io.containerd.image.name": _canonical_image_name(expected_image),
            "org.opencontainers.image.ref.name": tag,
        },
    )
    manifest_member = blob_members.get(manifest_digest)
    if manifest_member is None or manifest_member.size != manifest_size:
        raise SystemExit("Docker image archive OCI manifest blob is missing or has the wrong size")
    manifest = _read_json_member(
        archive, manifest_member, maximum_bytes=MAX_OCI_MANIFEST_BYTES, label="OCI manifest"
    )
    if (
        not isinstance(manifest, dict)
        or set(manifest) != {"schemaVersion", "mediaType", "config", "layers"}
        or manifest.get("schemaVersion") != 2
        or manifest.get("mediaType") != OCI_MANIFEST_MEDIA_TYPE
    ):
        raise SystemExit("Docker image archive OCI manifest is invalid")
    oci_config_digest, oci_config_size = _descriptor(
        manifest.get("config"), "OCI config", OCI_CONFIG_MEDIA_TYPE
    )
    config_name = docker_image.get("Config")
    if (
        not isinstance(config_name, str)
        or _blob_digest(config_name, "Docker Config") != config_digest
        or oci_config_digest != config_digest
        or oci_config_size != config_size
    ):
        raise SystemExit("Docker and OCI image config metadata do not match")

    docker_layers = docker_image.get("Layers")
    layer_sources = docker_image.get("LayerSources")
    oci_layers = manifest.get("layers")
    if (
        not isinstance(docker_layers, list)
        or not docker_layers
        or not isinstance(layer_sources, dict)
        or not isinstance(oci_layers, list)
        or len(oci_layers) != len(docker_layers)
    ):
        raise SystemExit("Docker and OCI layer metadata is missing or ambiguous")
    if (
        not isinstance(docker_config, dict)
        or docker_config.get("os") != "linux"
        or docker_config.get("architecture") != "amd64"
    ):
        raise SystemExit("Docker image platform must be linux/amd64")
    rootfs = docker_config.get("rootfs")
    expected_diff_ids = [
        f"sha256:{_blob_digest(layer, f'Docker layer {position}')}"
        for position, layer in enumerate(docker_layers)
        if isinstance(layer, str)
    ]
    if (
        not isinstance(rootfs, dict)
        or set(rootfs) != {"type", "diff_ids"}
        or rootfs.get("type") != "layers"
        or rootfs.get("diff_ids") != expected_diff_ids
        or len(expected_diff_ids) != len(docker_layers)
    ):
        raise SystemExit("Docker Config rootfs diff_ids do not match the archived layers")
    expected_source_keys: set[str] = set()
    for position, (layer_name, oci_layer) in enumerate(zip(docker_layers, oci_layers)):
        if not isinstance(layer_name, str):
            raise SystemExit("Docker and OCI layer metadata is invalid")
        layer_digest = _blob_digest(layer_name, f"Docker layer {position}")
        descriptor_digest, descriptor_size = _descriptor(
            oci_layer, f"OCI layer {position}", OCI_LAYER_MEDIA_TYPE
        )
        source_key = f"sha256:{layer_digest}"
        expected_source_keys.add(source_key)
        layer_member = blob_members.get(layer_digest)
        if (
            descriptor_digest != layer_digest
            or layer_sources.get(source_key) != oci_layer
            or layer_member is None
            or layer_member.size != descriptor_size
        ):
            raise SystemExit("Docker and OCI layer metadata do not match")
    if set(layer_sources) != expected_source_keys:
        raise SystemExit("Docker image archive LayerSources contains an unexpected layer")
    if repositories_target != _blob_digest(docker_layers[-1], "top Docker layer"):
        raise SystemExit("Docker repositories metadata does not match the top image layer")

    return f"sha256:{manifest_digest}"
