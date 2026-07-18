from __future__ import annotations

import hashlib
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPTS_ROOT = Path(__file__).resolve().parent
if str(SCRIPTS_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_ROOT))

from deploy_control_plane import docker_archive  # noqa: E402


EXPECTED_IMAGE = "p2p-transmission:2.0.1-test"
EXPECTED_CANONICAL_IMAGE = "docker.io/library/p2p-transmission:2.0.1-test"
LAYER_PAYLOAD = b"layer fixture"
LAYER_DIGEST = hashlib.sha256(LAYER_PAYLOAD).hexdigest()
LAYER_NAME = f"blobs/sha256/{LAYER_DIGEST}"


def json_bytes(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


CONFIG_PAYLOAD = json_bytes(
    {
        "architecture": "amd64",
        "os": "linux",
        "rootfs": {"type": "layers", "diff_ids": [f"sha256:{LAYER_DIGEST}"]},
    }
)
CONFIG_DIGEST = hashlib.sha256(CONFIG_PAYLOAD).hexdigest()
CONFIG_NAME = f"blobs/sha256/{CONFIG_DIGEST}"
EXPECTED_IMAGE_ID = f"sha256:{CONFIG_DIGEST}"
ALTERNATE_CONFIG_PAYLOAD = json_bytes(
    {
        "architecture": "arm64",
        "os": "linux",
        "rootfs": {"type": "layers", "diff_ids": [f"sha256:{LAYER_DIGEST}"]},
    }
)
WRONG_ROOTFS_CONFIG_PAYLOAD = json_bytes(
    {
        "architecture": "amd64",
        "os": "linux",
        "rootfs": {"type": "layers", "diff_ids": [f'sha256:{"f" * 64}']},
    }
)


def regular_member(name: str, payload: bytes) -> tuple[tarfile.TarInfo, bytes]:
    member = tarfile.TarInfo(name)
    member.size = len(payload)
    return member, payload


def directory_member(name: str) -> tuple[tarfile.TarInfo, None]:
    member = tarfile.TarInfo(name)
    member.type = tarfile.DIRTYPE
    return member, None


def write_archive(
    path: Path,
    entries: list[tuple[tarfile.TarInfo, bytes | None]],
) -> None:
    with tarfile.open(path, "w:gz") as archive:
        for member, payload in entries:
            archive.addfile(member, None if payload is None else io.BytesIO(payload))


def modern_entries(
    *,
    docker_config_payload: bytes = CONFIG_PAYLOAD,
    oci_config_payload: bytes | None = None,
    layer_blob_payload: bytes = LAYER_PAYLOAD,
    layer_source_size: int | bool | None = None,
    oci_layer_size: int | bool | None = None,
    repositories_target: str = LAYER_DIGEST,
    annotation_image: str = EXPECTED_CANONICAL_IMAGE,
    annotation_tag: str = "2.0.1-test",
    index_manifest_size_delta: int = 0,
) -> list[tuple[tarfile.TarInfo, bytes | None]]:
    docker_config_digest = hashlib.sha256(docker_config_payload).hexdigest()
    docker_config_name = f"blobs/sha256/{docker_config_digest}"
    selected_oci_config = oci_config_payload or docker_config_payload
    oci_config_digest = hashlib.sha256(selected_oci_config).hexdigest()
    layer_size = len(LAYER_PAYLOAD) if oci_layer_size is None else oci_layer_size
    layer_descriptor = {
        "mediaType": "application/vnd.oci.image.layer.v1.tar",
        "size": layer_size,
        "digest": f"sha256:{LAYER_DIGEST}",
    }
    source_descriptor = dict(layer_descriptor)
    if layer_source_size is not None:
        source_descriptor["size"] = layer_source_size
    docker_manifest = [
        {
            "Config": docker_config_name,
            "RepoTags": [EXPECTED_IMAGE],
            "Layers": [LAYER_NAME],
            "LayerSources": {f"sha256:{LAYER_DIGEST}": source_descriptor},
        }
    ]
    oci_manifest_payload = json_bytes(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": f"sha256:{oci_config_digest}",
                "size": len(selected_oci_config),
            },
            "layers": [layer_descriptor],
        }
    )
    oci_manifest_digest = hashlib.sha256(oci_manifest_payload).hexdigest()
    index = {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.index.v1+json",
        "manifests": [
            {
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "digest": f"sha256:{oci_manifest_digest}",
                "size": len(oci_manifest_payload) + index_manifest_size_delta,
                "annotations": {
                    "io.containerd.image.name": annotation_image,
                    "org.opencontainers.image.ref.name": annotation_tag,
                },
            }
        ],
    }
    legacy_config = b'{"id":"legacy-layer-config"}'
    legacy_config_digest = hashlib.sha256(legacy_config).hexdigest()
    entries: list[tuple[tarfile.TarInfo, bytes | None]] = [
        directory_member("blobs"),
        directory_member("blobs/sha256"),
        regular_member(docker_config_name, docker_config_payload),
        regular_member(LAYER_NAME, layer_blob_payload),
        regular_member(f"blobs/sha256/{oci_manifest_digest}", oci_manifest_payload),
        regular_member(f"blobs/sha256/{legacy_config_digest}", legacy_config),
    ]
    if oci_config_digest != docker_config_digest:
        entries.append(
            regular_member(f"blobs/sha256/{oci_config_digest}", selected_oci_config)
        )
    entries.extend(
        [
            regular_member("index.json", json_bytes(index)),
            regular_member("manifest.json", json_bytes(docker_manifest)),
            regular_member("oci-layout", json_bytes({"imageLayoutVersion": "1.0.0"})),
            regular_member(
                "repositories",
                json_bytes(
                    {"p2p-transmission": {"2.0.1-test": repositories_target}}
                ),
            ),
        ]
    )
    return entries


def replace_payload(
    entries: list[tuple[tarfile.TarInfo, bytes | None]],
    name: str,
    payload: bytes,
) -> None:
    position = next(index for index, (member, _payload) in enumerate(entries) if member.name == name)
    entries[position] = regular_member(name, payload)


class DockerImageArchiveTests(unittest.TestCase):
    def test_accepts_current_docker_save_layout_and_binds_load_to_config_digest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "image.tar.gz"
            write_archive(archive, modern_entries())

            self.assertEqual(
                docker_archive.inspect_docker_image_archive(archive, EXPECTED_IMAGE),
                EXPECTED_IMAGE_ID,
            )
            with (
                patch.object(docker_archive, "run") as run,
                patch.object(docker_archive, "image_id", return_value=EXPECTED_IMAGE_ID),
            ):
                self.assertEqual(
                    docker_archive.load_verified_docker_image_archive(archive, EXPECTED_IMAGE),
                    EXPECTED_IMAGE_ID,
                )
            run.assert_called_once_with(["docker", "load", "--input", str(archive)])

    def test_rejects_incomplete_or_ambiguous_metadata_before_load(self) -> None:
        cases: dict[str, list[tuple[tarfile.TarInfo, bytes | None]]] = {}
        for omitted in ("index.json", "oci-layout", "repositories"):
            cases[f"missing {omitted}"] = [
                entry for entry in modern_entries() if entry[0].name != omitted
            ]
        extra_manifest = modern_entries()
        manifest_position = next(
            index for index, (member, _payload) in enumerate(extra_manifest) if member.name == "manifest.json"
        )
        manifest = json.loads(extra_manifest[manifest_position][1] or b"null")
        manifest.append(dict(manifest[0]))
        replace_payload(extra_manifest, "manifest.json", json_bytes(manifest))
        cases["extra Docker image"] = extra_manifest
        extra_tag = modern_entries()
        tagged_manifest = json.loads(extra_tag[manifest_position][1] or b"null")
        tagged_manifest[0]["RepoTags"].append("p2p-transmission:unexpected")
        replace_payload(extra_tag, "manifest.json", json_bytes(tagged_manifest))
        cases["extra Docker tag"] = extra_tag
        extra_oci_image = modern_entries()
        index_position = next(
            index for index, (member, _payload) in enumerate(extra_oci_image)
            if member.name == "index.json"
        )
        index_payload = json.loads(extra_oci_image[index_position][1] or b"null")
        index_payload["manifests"].append(dict(index_payload["manifests"][0]))
        replace_payload(extra_oci_image, "index.json", json_bytes(index_payload))
        cases["extra OCI image"] = extra_oci_image

        for label, entries in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / "image.tar.gz"
                write_archive(archive, entries)
                with (
                    patch.object(docker_archive, "run") as run,
                    self.assertRaises(SystemExit),
                ):
                    docker_archive.load_verified_docker_image_archive(archive, EXPECTED_IMAGE)
                run.assert_not_called()

    def test_rejects_internally_valid_oci_metadata_that_disagrees_with_docker(self) -> None:
        cases = {
            "config": modern_entries(oci_config_payload=ALTERNATE_CONFIG_PAYLOAD),
            "platform": modern_entries(docker_config_payload=ALTERNATE_CONFIG_PAYLOAD),
            "LayerSources": modern_entries(layer_source_size=len(LAYER_PAYLOAD) + 1),
            "rootfs diff_ids": modern_entries(
                docker_config_payload=WRONG_ROOTFS_CONFIG_PAYLOAD
            ),
            "repositories": modern_entries(repositories_target="f" * 64),
            "image annotation": modern_entries(annotation_image="docker.io/library/other:tag"),
            "tag annotation": modern_entries(annotation_tag="other"),
        }
        for label, entries in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / "image.tar.gz"
                write_archive(archive, entries)
                with self.assertRaises(SystemExit):
                    docker_archive.inspect_docker_image_archive(archive, EXPECTED_IMAGE)

    def test_rejects_descriptor_size_and_blob_digest_tampering(self) -> None:
        tampered_layer = bytes([LAYER_PAYLOAD[0] ^ 1]) + LAYER_PAYLOAD[1:]
        cases = {
            "index manifest size": modern_entries(index_manifest_size_delta=1),
            "layer size": modern_entries(oci_layer_size=len(LAYER_PAYLOAD) + 1),
            "boolean layer size": modern_entries(oci_layer_size=True),
            "blob digest": modern_entries(layer_blob_payload=tampered_layer),
        }
        for label, entries in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / "image.tar.gz"
                write_archive(archive, entries)
                with self.assertRaises(SystemExit):
                    docker_archive.inspect_docker_image_archive(archive, EXPECTED_IMAGE)

    def test_rejects_non_finite_and_duplicate_json_values(self) -> None:
        cases: dict[str, tuple[str, bytes]] = {
            "NaN": ("oci-layout", b'{"imageLayoutVersion":"1.0.0","value":NaN}'),
            "Infinity": ("repositories", b'{"p2p-transmission":{"2.0.1-test":Infinity}}'),
            "duplicate": ("oci-layout", b'{"imageLayoutVersion":"1.0.0","imageLayoutVersion":"1.0.0"}'),
        }
        for label, (member_name, payload) in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / "image.tar.gz"
                entries = modern_entries()
                replace_payload(entries, member_name, payload)
                write_archive(archive, entries)
                with self.assertRaisesRegex(SystemExit, "invalid JSON"):
                    docker_archive.inspect_docker_image_archive(archive, EXPECTED_IMAGE)

    def test_rejects_duplicate_and_malicious_archive_members(self) -> None:
        duplicate = modern_entries()
        duplicate.append(regular_member("manifest.json", b"[]"))
        traversal = modern_entries()
        traversal.append(regular_member("../outside", b"unsafe"))
        symlink = tarfile.TarInfo("unsafe-link")
        symlink.type = tarfile.SYMTYPE
        symlink.linkname = "../../outside"
        link_entries = [*modern_entries(), (symlink, None)]
        nonempty_directory = modern_entries()
        directory_position = next(
            index for index, (member, _payload) in enumerate(nonempty_directory)
            if member.name == "blobs"
        )
        unsafe_directory = tarfile.TarInfo("blobs")
        unsafe_directory.type = tarfile.DIRTYPE
        unsafe_directory.size = 1
        nonempty_directory[directory_position] = (unsafe_directory, b"x")

        for label, entries in {
            "duplicate": duplicate,
            "traversal": traversal,
            "symlink": link_entries,
            "nonempty directory": nonempty_directory,
        }.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / "image.tar.gz"
                write_archive(archive, entries)
                with self.assertRaises(SystemExit):
                    docker_archive.inspect_docker_image_archive(archive, EXPECTED_IMAGE)

    def test_preexisting_tag_cannot_hide_a_failed_or_wrong_load(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / "image.tar.gz"
            write_archive(archive, modern_entries())
            preexisting_image_id = f'sha256:{"f" * 64}'
            with (
                patch.object(docker_archive, "run") as run,
                patch.object(docker_archive, "image_id", return_value=preexisting_image_id),
                self.assertRaisesRegex(SystemExit, "identity mismatch"),
            ):
                docker_archive.load_verified_docker_image_archive(archive, EXPECTED_IMAGE)
            run.assert_called_once()


if __name__ == "__main__":
    unittest.main()
