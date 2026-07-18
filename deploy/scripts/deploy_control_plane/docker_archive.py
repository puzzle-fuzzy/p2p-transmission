"""Strictly validate and load one Docker-save application image."""

from __future__ import annotations

import hashlib
import json
import tarfile
from pathlib import Path, PurePosixPath

from .common import image_id, run
from .oci_archive import validate_oci_image_layout


MAX_DOCKER_ARCHIVE_MEMBERS = 4096
MAX_DOCKER_MANIFEST_BYTES = 1024 * 1024
MAX_DOCKER_CONFIG_BYTES = 16 * 1024 * 1024
MAX_DOCKER_REPOSITORIES_BYTES = 1024 * 1024


def normalize_docker_archive_member_name(member: tarfile.TarInfo) -> str:
    """Return one unambiguous, relative POSIX member name."""

    raw_name = member.name
    if not raw_name or '\\' in raw_name or any(
        ord(character) < 32 or ord(character) == 127 for character in raw_name
    ):
        raise SystemExit(f'Docker image archive member name is unsafe: {raw_name!r}')

    name = raw_name[:-1] if member.isdir() and raw_name.endswith('/') else raw_name
    raw_parts = name.split('/')
    path = PurePosixPath(name)
    if (
        not name
        or path.is_absolute()
        or any(part in {'', '.', '..'} for part in raw_parts)
        or path.as_posix() != name
    ):
        raise SystemExit(f'Docker image archive member name is unsafe: {raw_name!r}')
    if (
        not (member.isfile() or member.isdir())
        or (member.isdir() and member.size != 0)
        or getattr(member, 'sparse', None)
    ):
        raise SystemExit(f'Docker image archive member is not a regular file or directory: {name}')
    return name


def read_docker_archive_member(
    archive: tarfile.TarFile,
    member: tarfile.TarInfo,
    *,
    maximum_bytes: int,
    label: str,
) -> bytes:
    if not member.isfile() or member.size < 0 or member.size > maximum_bytes:
        raise SystemExit(f'Docker image archive {label} is not a safe regular file')
    source = archive.extractfile(member)
    if source is None:
        raise SystemExit(f'Docker image archive {label} cannot be read')
    try:
        payload = source.read(maximum_bytes + 1)
    except (OSError, tarfile.TarError) as error:
        raise SystemExit(f'Docker image archive {label} cannot be read: {error}') from error
    if len(payload) != member.size or len(payload) > maximum_bytes:
        raise SystemExit(f'Docker image archive {label} is truncated or too large')
    return payload


def docker_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'duplicate JSON key: {key}')
        result[key] = value
    return result


def reject_docker_json_constant(value: str) -> object:
    raise ValueError(f'non-finite JSON number: {value}')


def parse_docker_archive_json(payload: bytes, label: str) -> object:
    try:
        return json.loads(
            payload.decode('utf-8'),
            object_pairs_hook=docker_json_object,
            parse_constant=reject_docker_json_constant,
        )
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit(f'Docker image archive {label} is invalid JSON: {error}') from error


def docker_config_digest(config_name: str) -> str:
    parts = PurePosixPath(config_name).parts
    digest = parts[2] if len(parts) == 3 and parts[:2] == ('blobs', 'sha256') else None
    if (
        digest is None
        or len(digest) != 64
        or any(character not in '0123456789abcdef' for character in digest)
    ):
        raise SystemExit('Docker image archive Config filename is not a SHA-256 digest')
    return digest


def validate_docker_repositories_metadata(
    archive: tarfile.TarFile,
    member: tarfile.TarInfo,
    expected_image: str,
) -> str:
    payload = read_docker_archive_member(
        archive,
        member,
        maximum_bytes=MAX_DOCKER_REPOSITORIES_BYTES,
        label='repositories metadata',
    )
    repositories = parse_docker_archive_json(payload, 'repositories metadata')
    repository, separator, tag = expected_image.rpartition(':')
    if not separator or not repository or not tag:
        raise SystemExit(f'expected Docker image tag is invalid: {expected_image}')
    if (
        not isinstance(repositories, dict)
        or set(repositories) != {repository}
        or not isinstance(repositories[repository], dict)
        or set(repositories[repository]) != {tag}
        or not isinstance(repositories[repository][tag], str)
        or not repositories[repository][tag]
    ):
        raise SystemExit(
            'Docker image archive repositories metadata contains an unexpected image or tag'
        )
    return repositories[repository][tag]


def inspect_docker_image_archive(image_archive: Path, expected_image: str) -> str:
    """Validate a Docker save archive and return its immutable image ID."""

    members: dict[str, tarfile.TarInfo] = {}
    try:
        with tarfile.open(image_archive, mode='r:*') as archive:
            for index, member in enumerate(archive, start=1):
                if index > MAX_DOCKER_ARCHIVE_MEMBERS:
                    raise SystemExit('Docker image archive contains too many members')
                name = normalize_docker_archive_member_name(member)
                if name in members:
                    raise SystemExit(f'Docker image archive contains duplicate member: {name}')
                members[name] = member

            manifest_member = members.get('manifest.json')
            if manifest_member is None:
                raise SystemExit('Docker image archive manifest.json is missing')
            required_metadata = {'manifest.json', 'repositories', 'index.json', 'oci-layout'}
            if not required_metadata.issubset(members):
                raise SystemExit(
                    'Docker image archive must use the complete modern Docker and OCI layout'
                )
            manifest_payload = read_docker_archive_member(
                archive,
                manifest_member,
                maximum_bytes=MAX_DOCKER_MANIFEST_BYTES,
                label='manifest.json',
            )
            manifest = parse_docker_archive_json(manifest_payload, 'manifest.json')
            if not isinstance(manifest, list) or len(manifest) != 1:
                raise SystemExit('Docker image archive must contain exactly one image')
            image = manifest[0]
            if not isinstance(image, dict):
                raise SystemExit('Docker image archive manifest entry is invalid')
            if image.get('RepoTags') != [expected_image]:
                raise SystemExit(
                    f'Docker image archive RepoTags must equal [{expected_image!r}]'
                )

            config_name = image.get('Config')
            if not isinstance(config_name, str):
                raise SystemExit('Docker image archive Config is invalid')
            config_path = PurePosixPath(config_name)
            if (
                not config_name
                or '\\' in config_name
                or config_path.is_absolute()
                or any(part in {'', '.', '..'} for part in config_name.split('/'))
                or config_path.as_posix() != config_name
            ):
                raise SystemExit('Docker image archive Config path is unsafe')
            config_member = members.get(config_name)
            if config_member is None:
                raise SystemExit('Docker image archive Config member is missing')
            config_payload = read_docker_archive_member(
                archive,
                config_member,
                maximum_bytes=MAX_DOCKER_CONFIG_BYTES,
                label='Config',
            )
            config_digest = docker_config_digest(config_name)
            actual_config_digest = hashlib.sha256(config_payload).hexdigest()
            if actual_config_digest != config_digest:
                raise SystemExit('Docker image archive Config digest does not match its filename')
            config = parse_docker_archive_json(config_payload, 'Config')

            layers = image.get('Layers')
            if (
                not isinstance(layers, list)
                or any(not isinstance(layer, str) for layer in layers)
                or len(set(layers)) != len(layers)
            ):
                raise SystemExit('Docker image archive Layers list is invalid')
            for layer in layers:
                layer_member = members.get(layer)
                if layer_member is None or not layer_member.isfile():
                    raise SystemExit(f'Docker image archive layer is missing or unsafe: {layer!r}')

            repositories_target = validate_docker_repositories_metadata(
                archive,
                members['repositories'],
                expected_image,
            )
            validate_oci_image_layout(
                archive,
                members,
                expected_image,
                image,
                config,
                config_digest,
                len(config_payload),
                repositories_target,
            )
    except SystemExit:
        raise
    except (OSError, tarfile.TarError, EOFError) as error:
        raise SystemExit(f'cannot inspect Docker image archive: {error}') from error

    return f'sha256:{config_digest}'


def load_verified_docker_image_archive(image_archive: Path, expected_image: str) -> str:
    expected_image_id = inspect_docker_image_archive(image_archive, expected_image)
    run(['docker', 'load', '--input', str(image_archive)])
    actual_image_id = image_id(expected_image)
    if actual_image_id != expected_image_id:
        raise SystemExit(
            f'loaded Docker image identity mismatch for {expected_image}: '
            f'expected {expected_image_id}, got {actual_image_id or "missing"}'
        )
    return expected_image_id
