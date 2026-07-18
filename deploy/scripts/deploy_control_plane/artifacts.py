"""Bind, validate, stage, extract, and retire untrusted release artifacts."""

import hashlib
import hmac
import json
import os
import re
import shutil
import stat
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Optional

from .common import (
    APP_DIR,
    ARTIFACT_SNAPSHOT_PREFIX,
    IMAGE_ARCHIVE_RE,
    MAX_RUNTIME_CONFIG_BYTES,
    SOURCE_ARCHIVE_RE,
    SOURCE_MANIFEST,
    TRACKED_RUNTIME_CONFIG_HASHES,
    UPLOAD_ROOT,
    atomic_write_bytes,
    fsync_directory,
    normalize_source_path,
    path_is_linklike,
    run,
    safe_source_target,
)
from .capacity import DiskDemand, require_disk_capacity
from .release_state import ensure_rollback_directory


@dataclass(frozen=True)
class ReleaseArtifactSnapshot:
    root: Path
    source_archive: Path
    image_archive: Path

    def cleanup(self) -> None:
        for path in (self.source_archive, self.image_archive):
            try:
                metadata = path.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
                raise SystemExit(f'private release artifact became unsafe: {path}')
            path.unlink()
        self.root.rmdir()

def validate_tmp_file(path: Path, pattern: re.Pattern[str], label: str) -> Path:
    resolved = Path(os.path.abspath(path))
    if resolved.parent != UPLOAD_ROOT or not pattern.fullmatch(resolved.name):
        raise SystemExit(f'{label} must use the expected name under {UPLOAD_ROOT}')
    try:
        metadata = resolved.lstat()
    except OSError as error:
        raise SystemExit(f'{label} does not exist or is not a regular file') from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise SystemExit(f'{label} does not exist or is not a regular file')
    return resolved

def validate_private_artifact(
    path: Path,
    pattern: re.Pattern[str],
    label: str,
    trusted_root: Path,
) -> Path:
    try:
        root = trusted_root.resolve(strict=True)
        resolved = path.resolve(strict=True)
        metadata = path.lstat()
    except OSError as error:
        raise SystemExit(f'{label} private snapshot is unavailable: {error}') from error
    if resolved.parent != root or not pattern.fullmatch(resolved.name):
        raise SystemExit(f'{label} escaped its private snapshot directory')
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise SystemExit(f'{label} private snapshot is not a regular file')
    effective_uid = getattr(os, 'geteuid', lambda: metadata.st_uid)()
    if os.name != 'nt' and (
        metadata.st_uid != effective_uid or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        raise SystemExit(f'{label} private snapshot ownership or mode is unsafe')
    return resolved

def artifact_file(
    path: Path,
    pattern: re.Pattern[str],
    label: str,
    trusted_root: Optional[Path],
) -> Path:
    if trusted_root is None:
        return validate_tmp_file(path, pattern, label)
    return validate_private_artifact(path, pattern, label, trusted_root)

def open_uploaded_artifact(
    path: Path,
    pattern: re.Pattern[str],
    label: str,
) -> tuple[Path, BinaryIO, os.stat_result]:
    resolved = validate_tmp_file(path, pattern, label)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(resolved, flags)
        source = os.fdopen(descriptor, 'rb')
        metadata = os.fstat(source.fileno())
    except OSError as error:
        raise SystemExit(f'cannot bind {label} for private staging: {error}') from error
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        source.close()
        raise SystemExit(f'{label} must be a single regular uploaded file')
    if os.name != 'nt' and stat.S_IMODE(metadata.st_mode) != 0o600:
        source.close()
        raise SystemExit(f'{label} uploaded file mode must be 0600')
    return resolved, source, metadata

def copy_bound_artifact(
    source: BinaryIO,
    initial: os.stat_result,
    destination: Path,
    label: str,
) -> None:
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, 'O_NOFOLLOW', 0)
    )
    descriptor: Optional[int] = None
    try:
        descriptor = os.open(destination, flags, 0o600)
        with os.fdopen(descriptor, 'wb') as target:
            descriptor = None
            shutil.copyfileobj(source, target, length=1024 * 1024)
            target.flush()
            os.fsync(target.fileno())
        final = os.fstat(source.fileno())
        identity = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        if any(getattr(initial, field) != getattr(final, field) for field in identity):
            raise SystemExit(f'{label} changed while it was copied into private staging')
        os.chmod(destination, 0o600)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    finally:
        if descriptor is not None:
            os.close(descriptor)

def snapshot_release_artifacts(
    source_archive: Path,
    image_archive: Path,
) -> ReleaseArtifactSnapshot:
    specifications = (
        (source_archive, SOURCE_ARCHIVE_RE, 'source archive'),
        (image_archive, IMAGE_ARCHIVE_RE, 'image archive'),
    )
    opened: list[tuple[Path, BinaryIO, os.stat_result, str]] = []
    snapshot: Optional[ReleaseArtifactSnapshot] = None
    stage_root: Optional[Path] = None
    try:
        for path, pattern, label in specifications:
            resolved, source, metadata = open_uploaded_artifact(path, pattern, label)
            opened.append((resolved, source, metadata, label))

        rollback_root = ensure_rollback_directory()
        require_disk_capacity([
            DiskDemand(
                'root-owned release artifact snapshot',
                rollback_root,
                sum(metadata.st_size for _, _, metadata, _ in opened),
            )
        ])
        stage_root = Path(
            tempfile.mkdtemp(prefix=ARTIFACT_SNAPSHOT_PREFIX, dir=rollback_root)
        )
        os.chmod(stage_root, 0o700)
        destinations: list[Path] = []
        for (resolved, source, metadata, label), (_, pattern, _) in zip(
            opened,
            specifications,
            strict=True,
        ):
            destination = stage_root / resolved.name
            if not pattern.fullmatch(destination.name):
                raise SystemExit(f'{label} private snapshot name is invalid')
            copy_bound_artifact(source, metadata, destination, label)
            destinations.append(destination)
        fsync_directory(stage_root)
        fsync_directory(rollback_root)
        snapshot = ReleaseArtifactSnapshot(
            root=stage_root,
            source_archive=destinations[0],
            image_archive=destinations[1],
        )
        return snapshot
    finally:
        for _, source, _, _ in opened:
            source.close()
        if snapshot is None and stage_root is not None:
            for child in stage_root.iterdir():
                child.unlink(missing_ok=True)
            stage_root.rmdir()

def remove_uploaded_artifact(path: Path, pattern: re.Pattern[str]) -> None:
    candidate = Path(os.path.abspath(path))
    if candidate.parent != UPLOAD_ROOT or not pattern.fullmatch(candidate.name):
        return
    try:
        metadata = candidate.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
        return
    candidate.unlink(missing_ok=True)

def source_archive_files(archive: Path) -> set[str]:
    files: set[str] = set()
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar.getmembers():
            if member.issym() or member.islnk():
                raise SystemExit('source archive must not contain symbolic links')
            if not member.isfile() and not member.isdir():
                raise SystemExit(f'source archive contains an unsupported entry: {member.name}')
            normalized = normalize_source_path(member.name.rstrip('/'))
            if source_path_is_protected(normalized):
                raise SystemExit(
                    f'source archive contains a protected production path: {normalized}'
                )
            safe_source_target(normalized)
            if member.isfile():
                files.add(normalized)
    return files

def verify_tracked_runtime_configuration(archive: Path) -> None:
    """Keep unprivileged release uploads from changing host-root configuration."""

    with tarfile.open(archive, 'r:gz') as tar:
        members: dict[str, tarfile.TarInfo] = {}
        for member in tar.getmembers():
            normalized = normalize_source_path(member.name.rstrip('/'))
            if normalized in TRACKED_RUNTIME_CONFIG_HASHES:
                if normalized in members or not member.isfile():
                    raise SystemExit(
                        f'source archive runtime configuration is ambiguous: {normalized}'
                    )
                members[normalized] = member
        for path, expected in TRACKED_RUNTIME_CONFIG_HASHES.items():
            member = members.get(path)
            if member is None:
                raise SystemExit(f'source archive is missing runtime configuration: {path}')
            source = tar.extractfile(member)
            if source is None:
                raise SystemExit(f'cannot read runtime configuration from source archive: {path}')
            payload = source.read(MAX_RUNTIME_CONFIG_BYTES + 1)
            if len(payload) > MAX_RUNTIME_CONFIG_BYTES:
                raise SystemExit(f'source archive runtime configuration is too large: {path}')
            actual = hashlib.sha256(payload).hexdigest()
            if not hmac.compare_digest(actual, expected):
                raise SystemExit(
                    f'source archive runtime configuration is not approved: {path}'
                )

def validate_source_archive(
    archive: Path,
    *,
    trusted_root: Optional[Path] = None,
) -> Path:
    resolved = artifact_file(
        archive,
        SOURCE_ARCHIVE_RE,
        'source archive',
        trusted_root,
    )
    source_archive_files(resolved)
    verify_tracked_runtime_configuration(resolved)
    return resolved

def validate_image_archive(
    archive: Path,
    *,
    trusted_root: Optional[Path] = None,
) -> Path:
    return artifact_file(
        archive,
        IMAGE_ARCHIVE_RE,
        'image archive',
        trusted_root,
    )

def read_source_file_list(path: Path) -> set[str]:
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f'cannot read source file list {path}: {error}') from error
    if not isinstance(payload, list) or not all(isinstance(item, str) for item in payload):
        raise SystemExit(f'source file list must be a JSON string array: {path}')
    return {normalize_source_path(item) for item in payload}

def source_path_is_protected(path: str) -> bool:
    parts = PurePosixPath(path).parts
    if not parts:
        return True
    if parts[0] == '.git':
        return True
    protected_prefixes = (
        ('deploy', 'production', '.env'),
        ('deploy', 'production', 'data'),
        ('deploy', 'production', 'backups'),
        ('deploy', 'production', 'rollback'),
        ('deploy', 'production', 'source-files.json'),
        ('deploy', 'coturn', '.local'),
        ('deploy', 'coturn', 'turnserver.conf'),
        ('deploy', '.env'),
        ('deploy', 'data'),
    )
    if any(parts[: len(prefix)] == prefix for prefix in protected_prefixes):
        return True
    if parts[:2] == ('deploy', 'coturn') and path.endswith(('.pem', '.key')):
        return True
    return parts[0] == 'deploy' and (
        path.endswith('.sqlite') or '.sqlite-' in PurePosixPath(path).name
    )

def write_source_manifest(files: set[str]) -> None:
    payload = (json.dumps(sorted(files), ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    atomic_write_bytes(SOURCE_MANIFEST, payload, 0o600)

def read_source_manifest() -> set[str]:
    try:
        metadata = SOURCE_MANIFEST.lstat()
    except OSError as error:
        raise SystemExit(
            'current production source manifest is missing; clean bootstrap is required'
        ) from error
    effective_uid = getattr(os, 'geteuid', lambda: metadata.st_uid)()
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or (
            os.name != 'nt'
            and (
                metadata.st_uid != effective_uid
                or stat.S_IMODE(metadata.st_mode) != 0o600
            )
        )
    ):
        raise SystemExit('current production source manifest is unsafe')
    return read_source_file_list(SOURCE_MANIFEST)


def remove_retired_source_files(current_files: set[str]) -> int:
    previous_files = read_source_manifest()
    retired = previous_files - current_files
    parent_directories: set[Path] = set()
    removed = 0

    for relative in sorted(retired, key=lambda item: (item.count('/'), item), reverse=True):
        if source_path_is_protected(relative):
            print(f'preserving protected production path: {relative}', flush=True)
            continue
        pure = PurePosixPath(relative)
        target = safe_source_target(relative)
        if target.is_symlink() or target.is_file():
            target.unlink()
            removed += 1
        elif target.exists() and not target.is_dir():
            raise SystemExit(f'cannot safely remove retired source path: {relative}')
        parent_directories.update(
            APP_DIR.joinpath(*parent.parts)
            for parent in pure.parents
            if parent != PurePosixPath('.')
        )

    for directory in sorted(
        parent_directories,
        key=lambda item: (len(item.relative_to(APP_DIR).parts), str(item)),
        reverse=True,
    ):
        relative = directory.relative_to(APP_DIR).as_posix()
        safe_directory = safe_source_target(relative)
        if (
            source_path_is_protected(relative)
            or not safe_directory.is_dir()
            or path_is_linklike(safe_directory)
        ):
            continue
        try:
            safe_directory.rmdir()
        except OSError:
            pass

    print(f'retired source files removed: {removed}', flush=True)
    return removed

def extract_archive(archive: Path) -> None:
    run([
        'tar',
        '--extract',
        '--gzip',
        '--file',
        str(archive),
        '--directory',
        str(APP_DIR),
        '--no-same-owner',
        '--no-same-permissions',
    ])
