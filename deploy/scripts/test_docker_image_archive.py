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


EXPECTED_IMAGE = 'p2p-transmission:2.0.1-test'
CONFIG_PAYLOAD = b'{"architecture":"amd64","rootfs":{"type":"layers","diff_ids":[]}}'
CONFIG_DIGEST = hashlib.sha256(CONFIG_PAYLOAD).hexdigest()
CONFIG_NAME = f'{CONFIG_DIGEST}.json'
EXPECTED_IMAGE_ID = f'sha256:{CONFIG_DIGEST}'


def regular_member(name: str, payload: bytes) -> tuple[tarfile.TarInfo, bytes]:
    member = tarfile.TarInfo(name)
    member.size = len(payload)
    return member, payload


def write_archive(
    path: Path,
    entries: list[tuple[tarfile.TarInfo, bytes | None]],
) -> None:
    with tarfile.open(path, 'w:gz') as archive:
        for member, payload in entries:
            archive.addfile(member, None if payload is None else io.BytesIO(payload))


def manifest_payload(
    *,
    repo_tags: list[str] | None = None,
    entries: int = 1,
    config: str = CONFIG_NAME,
) -> bytes:
    image = {
        'Config': config,
        'RepoTags': repo_tags if repo_tags is not None else [EXPECTED_IMAGE],
        'Layers': ['layer/layer.tar'],
    }
    return json.dumps([image] * entries, separators=(',', ':')).encode('utf-8')


def valid_entries() -> list[tuple[tarfile.TarInfo, bytes | None]]:
    return [
        regular_member('manifest.json', manifest_payload()),
        regular_member(CONFIG_NAME, CONFIG_PAYLOAD),
        regular_member('layer/layer.tar', b'layer fixture'),
        regular_member(
            'repositories',
            json.dumps(
                {'p2p-transmission': {'2.0.1-test': CONFIG_DIGEST}},
                separators=(',', ':'),
            ).encode('utf-8'),
        ),
    ]


class DockerImageArchiveTests(unittest.TestCase):
    def test_accepts_one_exact_image_and_binds_load_to_config_digest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'image.tar.gz'
            write_archive(archive, valid_entries())

            self.assertEqual(
                docker_archive.inspect_docker_image_archive(archive, EXPECTED_IMAGE),
                EXPECTED_IMAGE_ID,
            )
            with (
                patch.object(docker_archive, 'run') as run,
                patch.object(docker_archive, 'image_id', return_value=EXPECTED_IMAGE_ID),
            ):
                self.assertEqual(
                    docker_archive.load_verified_docker_image_archive(archive, EXPECTED_IMAGE),
                    EXPECTED_IMAGE_ID,
                )
            run.assert_called_once_with(
                ['docker', 'load', '--input', str(archive)]
            )

    def test_rejects_extra_manifest_image_or_repo_tag_before_load(self) -> None:
        cases = {
            'extra image': manifest_payload(entries=2),
            'extra RepoTag': manifest_payload(
                repo_tags=[EXPECTED_IMAGE, 'coturn/coturn:latest']
            ),
        }
        for label, payload in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / 'image.tar.gz'
                entries = valid_entries()
                entries[0] = regular_member('manifest.json', payload)
                write_archive(archive, entries)
                with (
                    patch.object(docker_archive, 'run') as run,
                    self.assertRaises(SystemExit),
                ):
                    docker_archive.load_verified_docker_image_archive(archive, EXPECTED_IMAGE)
                run.assert_not_called()

    def test_rejects_a_second_oci_index_interpretation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'image.tar.gz'
            entries = valid_entries()
            entries.append(regular_member('index.json', b'{"manifests":[]}'))
            entries.append(regular_member('oci-layout', b'{"imageLayoutVersion":"1.0.0"}'))
            write_archive(archive, entries)
            with self.assertRaisesRegex(SystemExit, 'must not mix'):
                docker_archive.inspect_docker_image_archive(archive, EXPECTED_IMAGE)

    def test_rejects_extra_repository_metadata_tag(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'image.tar.gz'
            entries = valid_entries()
            entries[-1] = regular_member(
                'repositories',
                json.dumps(
                    {
                        'p2p-transmission': {
                            '2.0.1-test': CONFIG_DIGEST,
                            'unexpected': CONFIG_DIGEST,
                        }
                    }
                ).encode('utf-8'),
            )
            write_archive(archive, entries)
            with self.assertRaisesRegex(SystemExit, 'unexpected image or tag'):
                docker_archive.inspect_docker_image_archive(archive, EXPECTED_IMAGE)

    def test_rejects_duplicate_and_malicious_archive_members(self) -> None:
        duplicate = valid_entries()
        duplicate.append(regular_member('manifest.json', manifest_payload()))

        traversal = valid_entries()
        traversal.append(regular_member('../outside', b'unsafe'))

        symlink = tarfile.TarInfo('unsafe-link')
        symlink.type = tarfile.SYMTYPE
        symlink.linkname = '../../outside'
        link_entries = [*valid_entries(), (symlink, None)]

        for label, entries in {
            'duplicate': duplicate,
            'traversal': traversal,
            'symlink': link_entries,
        }.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / 'image.tar.gz'
                write_archive(archive, entries)
                with self.assertRaises(SystemExit):
                    docker_archive.inspect_docker_image_archive(archive, EXPECTED_IMAGE)

    def test_rejects_config_digest_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'image.tar.gz'
            entries = valid_entries()
            entries[1] = regular_member(CONFIG_NAME, b'tampered config')
            write_archive(archive, entries)
            with self.assertRaisesRegex(SystemExit, 'Config digest'):
                docker_archive.inspect_docker_image_archive(archive, EXPECTED_IMAGE)

    def test_preexisting_tag_cannot_hide_a_failed_or_wrong_load(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive = Path(directory) / 'image.tar.gz'
            write_archive(archive, valid_entries())
            preexisting_image_id = f'sha256:{"f" * 64}'
            with (
                patch.object(docker_archive, 'run') as run,
                patch.object(docker_archive, 'image_id', return_value=preexisting_image_id),
                self.assertRaisesRegex(SystemExit, 'identity mismatch'),
            ):
                docker_archive.load_verified_docker_image_archive(archive, EXPECTED_IMAGE)
            run.assert_called_once()


if __name__ == '__main__':
    unittest.main()
