"""Peak disk-capacity accounting for release and maintenance operations."""

import json
import shutil
import stat
import subprocess
import tarfile
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .common import (
    APP_DIR,
    DISK_SAFETY_MARGIN_BYTES,
    PRODUCTION_BACKUPS,
    PRODUCTION_DATA,
    path_is_linklike,
)
from .database import production_database_runtime_files


@dataclass(frozen=True)
class DiskDemand:
    label: str
    path: Path
    working_bytes: int

@dataclass(frozen=True)
class DiskCapacity:
    path: Path
    labels: tuple[str, ...]
    working_bytes: int
    required_bytes: int
    free_bytes: int

def archive_working_bytes(archive: Path, label: str) -> int:
    """Return a conservative extraction/load footprint for a compressed tar archive."""

    if path_is_linklike(archive) or not archive.is_file():
        raise SystemExit(f'{label} is missing or unsafe')
    try:
        archived_bytes = archive.stat().st_size
        with tarfile.open(archive, 'r:*') as bundle:
            expanded_bytes = sum(member.size for member in bundle if member.isfile())
    except (OSError, tarfile.TarError) as error:
        raise SystemExit(f'cannot inspect {label} disk requirements: {error}') from error
    return max(archived_bytes, expanded_bytes)

def disk_anchor(path: Path) -> Path:
    """Resolve the closest existing directory that owns a future output path."""

    candidate = path
    while not candidate.exists():
        parent = candidate.parent
        if parent == candidate:
            raise SystemExit(f'cannot locate a filesystem for disk budget path: {path}')
        candidate = parent
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise SystemExit(f'cannot resolve disk budget path {path}: {error}') from error
    if resolved.is_file():
        resolved = resolved.parent
    if not resolved.is_dir():
        raise SystemExit(f'disk budget path is not a directory: {path}')
    return resolved

def filesystem_device(path: Path) -> int:
    try:
        return path.stat().st_dev
    except OSError as error:
        raise SystemExit(
            f'cannot inspect filesystem for disk budget path {path}: {error}'
        ) from error

def require_disk_capacity(
    demands: list[DiskDemand],
    *,
    safety_bytes: int = DISK_SAFETY_MARGIN_BYTES,
) -> list[DiskCapacity]:
    """Check peak new bytes per filesystem, adding the safety margin once per device."""

    if safety_bytes < 0:
        raise ValueError('disk safety margin must not be negative')
    grouped: dict[int, list[tuple[DiskDemand, Path]]] = {}
    for demand in demands:
        if demand.working_bytes < 0:
            raise ValueError(f'disk demand must not be negative: {demand.label}')
        anchor = disk_anchor(demand.path)
        grouped.setdefault(filesystem_device(anchor), []).append((demand, anchor))

    capacities: list[DiskCapacity] = []
    for entries in grouped.values():
        representative = entries[0][1]
        working_bytes = sum(demand.working_bytes for demand, _ in entries)
        required_bytes = working_bytes + safety_bytes
        try:
            free_bytes = shutil.disk_usage(representative).free
        except OSError as error:
            raise SystemExit(
                f'cannot inspect free space for {representative}: {error}'
            ) from error
        labels = tuple(sorted(demand.label for demand, _ in entries))
        if free_bytes < required_bytes:
            raise SystemExit(
                'insufficient disk space for '
                f'{", ".join(labels)} on {representative}: '
                f'{free_bytes} bytes free, {required_bytes} bytes required'
            )
        capacities.append(
            DiskCapacity(
                path=representative,
                labels=labels,
                working_bytes=working_bytes,
                required_bytes=required_bytes,
                free_bytes=free_bytes,
            )
        )
    return sorted(capacities, key=lambda capacity: str(capacity.path))

def discover_docker_root() -> Optional[Path]:
    """Return DockerRootDir only when Docker reports an existing absolute directory."""

    result = subprocess.run(
        ['docker', 'info', '--format', '{{json .DockerRootDir}}'],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    try:
        raw_path = json.loads(result.stdout.strip())
    except json.JSONDecodeError:
        return None
    if not isinstance(raw_path, str) or not raw_path or not Path(raw_path).is_absolute():
        return None
    candidate = Path(raw_path)
    try:
        resolved = candidate.resolve(strict=True)
    except OSError:
        return None
    return resolved if resolved.is_dir() else None

def production_database_working_bytes() -> int:
    """Estimate a consistent SQLite snapshot using the DB and live journal footprint."""

    total = 0
    for path in production_database_runtime_files():
        if path_is_linklike(path):
            raise SystemExit(f'production database runtime path is unsafe: {path}')
        try:
            metadata = path.stat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise SystemExit(f'cannot inspect production database size: {error}') from error
        if not stat.S_ISREG(metadata.st_mode):
            raise SystemExit(f'production database runtime path is unsafe: {path}')
        total += metadata.st_size
    return total

def stage_disk_demands(
    source_archive: Path,
    image_archive: Path,
    docker_root: Optional[Path],
) -> list[DiskDemand]:
    database_bytes = production_database_working_bytes()
    image_path = APP_DIR if docker_root is None else docker_root
    return [
        DiskDemand(
            'source archive extraction',
            APP_DIR,
            archive_working_bytes(source_archive, 'source archive'),
        ),
        DiskDemand('database backup', PRODUCTION_BACKUPS, database_bytes),
        DiskDemand('database rollback restore', PRODUCTION_DATA, database_bytes),
        DiskDemand(
            'Docker image load',
            image_path,
            archive_working_bytes(image_archive, 'image archive'),
        ),
    ]

def require_stage_disk_capacity(
    source_archive: Path,
    image_archive: Path,
) -> list[DiskCapacity]:
    docker_root = discover_docker_root()
    if docker_root is None:
        print(
            'Docker root could not be determined; charging image load to the application disk',
            flush=True,
        )
    return require_disk_capacity(stage_disk_demands(source_archive, image_archive, docker_root))

def maintenance_disk_demands(
    backup: Optional[Path],
    *,
    create_backup: bool,
) -> list[DiskDemand]:
    if create_backup:
        database_bytes = production_database_working_bytes()
        return [
            DiskDemand('database backup', PRODUCTION_BACKUPS, database_bytes),
            DiskDemand('database restore drill', PRODUCTION_BACKUPS, database_bytes),
        ]
    if backup is None or path_is_linklike(backup) or not backup.is_file():
        raise SystemExit('database restore drill input is missing or unsafe')
    return [DiskDemand('database restore drill', PRODUCTION_BACKUPS, backup.stat().st_size)]
