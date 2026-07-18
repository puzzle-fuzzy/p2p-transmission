"""Owned-file, atomic I/O, and global-lock security boundary."""

from __future__ import annotations

import json
import os
import stat
import tempfile
from pathlib import Path
from typing import BinaryIO, Optional

from . import state

try:  # pragma: no cover - unavailable on Windows, where the unit tests run.
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]


def _current_uid() -> Optional[int]:
    getuid = getattr(os, 'getuid', None)
    return getuid() if getuid is not None else None


def _close_descriptor(descriptor: int) -> None:
    try:
        os.close(descriptor)
    except OSError:
        pass


def lstat_regular(path: Path, *, require_owner: bool = False) -> os.stat_result:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise state.SupervisorError(f'required file is unavailable: {path}: {error}') from error
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise state.SupervisorError(f'file is not a safe regular file: {path}')
    if metadata.st_nlink != 1:
        raise state.SupervisorError(f'file must have exactly one hard link: {path}')
    uid = _current_uid()
    if require_owner and uid is not None and metadata.st_uid != uid:
        raise state.SupervisorError(f'file is not owned by the deploy account: {path}')
    if (
        require_owner
        and os.name != 'nt'
        and stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        raise state.SupervisorError(f'file permissions must be 0600: {path}')
    return metadata

def _ensure_absent_or_owned_regular(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        raise state.SupervisorError(f'cannot inspect supervisor file {path}: {error}') from error
    lstat_regular(path, require_owner=True)


def validate_opened_owned_regular(descriptor: int, path: Path) -> os.stat_result:
    try:
        os.fchmod(descriptor, 0o600)
        opened = os.fstat(descriptor)
        expected = lstat_regular(path, require_owner=True)
    except OSError as error:
        raise state.SupervisorError(f'cannot validate opened file {path}: {error}') from error
    opened_identity = (
        opened.st_dev,
        opened.st_ino,
        opened.st_uid,
        stat.S_IMODE(opened.st_mode),
        opened.st_nlink,
    )
    expected_identity = (
        expected.st_dev,
        expected.st_ino,
        expected.st_uid,
        stat.S_IMODE(expected.st_mode),
        expected.st_nlink,
    )
    if opened_identity != expected_identity:
        raise state.SupervisorError(f'opened file does not match its fixed path: {path}')
    return opened

def atomic_write_bytes(path: Path, payload: bytes) -> None:
    """Atomically replace an operation-owned file with mode 0600."""

    if path.parent != state.TMP_ROOT:
        raise state.SupervisorError(f'supervisor output must stay directly under {state.TMP_ROOT}: {path}')
    _ensure_absent_or_owned_regular(path)
    descriptor: Optional[int] = None
    temporary: Optional[Path] = None
    try:
        descriptor, name = tempfile.mkstemp(prefix=f'.{path.name}.write-', dir=state.TMP_ROOT)
        temporary = Path(name)
        with os.fdopen(descriptor, 'wb') as destination:
            descriptor = None
            destination.write(payload)
            destination.flush()
            os.fsync(destination.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        temporary = None
    except OSError as error:
        raise state.SupervisorError(f'cannot atomically write {path}: {error}') from error
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temporary is not None:
            temporary.unlink(missing_ok=True)

def atomic_write_json(path: Path, payload: dict[str, object]) -> None:
    rendered = (json.dumps(payload, sort_keys=True, separators=(',', ':')) + '\n').encode()
    atomic_write_bytes(path, rendered)


def _remove_created_claim(path: Path, identity: Optional[tuple[int, int]]) -> None:
    if identity is None:
        return
    try:
        current = path.lstat()
        uid = _current_uid()
        if (
            stat.S_ISREG(current.st_mode)
            and (current.st_dev, current.st_ino) == identity
            and current.st_nlink == 1
            and stat.S_IMODE(current.st_mode) == 0o600
            and (uid is None or current.st_uid == uid)
        ):
            path.unlink()
    except OSError:
        pass


def create_exclusive_bytes(path: Path, payload: bytes) -> None:
    """Atomically claim one operation path without replacing existing state."""

    if path.parent != state.TMP_ROOT:
        raise state.SupervisorError(
            f'supervisor claim must stay directly under {state.TMP_ROOT}: {path}'
        )
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    descriptor: Optional[int] = None
    created_identity: Optional[tuple[int, int]] = None
    try:
        descriptor = os.open(path, flags, 0o600)
        opened = os.fstat(descriptor)
        created_identity = (opened.st_dev, opened.st_ino)
        os.fchmod(descriptor, 0o600)
        destination = os.fdopen(descriptor, 'wb')
        descriptor = None
        with destination:
            destination.write(payload)
            destination.flush()
            os.fsync(destination.fileno())
    except FileExistsError as error:
        raise state.SupervisorError(f'supervisor operation is already claimed: {path}') from error
    except OSError as error:
        if descriptor is not None:
            _close_descriptor(descriptor)
            descriptor = None
        _remove_created_claim(path, created_identity)
        raise state.SupervisorError(f'cannot create supervisor claim {path}: {error}') from error
    except BaseException:
        if descriptor is not None:
            _close_descriptor(descriptor)
            descriptor = None
        _remove_created_claim(path, created_identity)
        raise


def create_exclusive_json(path: Path, payload: dict[str, object]) -> None:
    rendered = (json.dumps(payload, sort_keys=True, separators=(',', ':')) + '\n').encode()
    create_exclusive_bytes(path, rendered)

def secure_read_bytes(path: Path, *, max_bytes: Optional[int] = None) -> bytes:
    metadata = lstat_regular(path, require_owner=path.parent == state.TMP_ROOT)
    if max_bytes is not None and metadata.st_size > max_bytes:
        raise state.SupervisorError(f'supervisor file exceeds its size limit: {path}')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, 'rb') as source:
            opened = os.fstat(source.fileno())
            if not stat.S_ISREG(opened.st_mode):
                raise state.SupervisorError(f'file changed while it was opened: {path}')
            identity = (
                metadata.st_dev,
                metadata.st_ino,
                metadata.st_uid,
                stat.S_IMODE(metadata.st_mode),
                metadata.st_nlink,
            )
            opened_identity = (
                opened.st_dev,
                opened.st_ino,
                opened.st_uid,
                stat.S_IMODE(opened.st_mode),
                opened.st_nlink,
            )
            if opened_identity != identity:
                raise state.SupervisorError(f'file changed while it was opened: {path}')
            return source.read(max_bytes + 1 if max_bytes is not None else -1)
    except OSError as error:
        raise state.SupervisorError(f'cannot read supervisor file {path}: {error}') from error

def read_json_file(path: Path) -> dict[str, object]:
    raw = secure_read_bytes(path, max_bytes=state.MAX_JSON_BYTES)
    if len(raw) > state.MAX_JSON_BYTES:
        raise state.SupervisorError(f'supervisor JSON exceeds its size limit: {path}')
    try:
        payload = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise state.SupervisorError(f'supervisor JSON is invalid: {path}: {error}') from error
    if not isinstance(payload, dict):
        raise state.SupervisorError(f'supervisor JSON must contain an object: {path}')
    return payload

def validate_release_artifacts(paths: state.OperationPaths) -> None:
    for artifact in (paths.source_archive, paths.image_archive, paths.retired_files):
        lstat_regular(artifact, require_owner=True)

def _open_lock_file() -> BinaryIO:
    if state.GLOBAL_LOCK.parent != state.TMP_ROOT:
        raise state.SupervisorError('global supervisor lock must remain directly under /tmp')
    _ensure_absent_or_owned_regular(state.GLOBAL_LOCK)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0)
    descriptor: Optional[int] = None
    try:
        descriptor = os.open(state.GLOBAL_LOCK, flags, 0o600)
        validate_opened_owned_regular(descriptor, state.GLOBAL_LOCK)
        return os.fdopen(descriptor, 'a+b', buffering=0)
    except state.SupervisorError:
        if descriptor is not None:
            _close_descriptor(descriptor)
        raise
    except OSError as error:
        if descriptor is not None:
            _close_descriptor(descriptor)
        raise state.SupervisorError(f'cannot open global supervisor lock: {error}') from error

def acquire_global_lock(*, nonblocking: bool = True) -> BinaryIO:
    if fcntl is None:
        raise state.SupervisorError('the deployment supervisor requires POSIX flock support')
    lock = _open_lock_file()
    flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0)
    try:
        fcntl.flock(lock.fileno(), flags)
    except BlockingIOError as error:
        lock.close()
        raise state.LockBusy('another deployment worker is already running') from error
    except OSError as error:
        lock.close()
        raise state.SupervisorError(f'cannot acquire the global supervisor lock: {error}') from error
    return lock


def acquire_operation_lock(
    paths: state.OperationPaths,
    *,
    nonblocking: bool = True,
) -> BinaryIO:
    if fcntl is None:
        raise state.SupervisorError('the deployment supervisor requires POSIX flock support')
    path = paths.operation_lock
    if path.parent != state.TMP_ROOT:
        raise state.SupervisorError('operation lock must remain directly under /tmp')
    _ensure_absent_or_owned_regular(path)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0)
    descriptor: Optional[int] = None
    lock: Optional[BinaryIO] = None
    try:
        descriptor = os.open(path, flags, 0o600)
        validate_opened_owned_regular(descriptor, path)
        lock = os.fdopen(descriptor, 'a+b', buffering=0)
        descriptor = None
        flags = fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0)
        fcntl.flock(lock.fileno(), flags)
        return lock
    except BlockingIOError as error:
        if lock is not None:
            lock.close()
        raise state.LockBusy('this deployment operation already has an active worker') from error
    except state.SupervisorError:
        if lock is not None:
            lock.close()
        elif descriptor is not None:
            _close_descriptor(descriptor)
        raise
    except OSError as error:
        if lock is not None:
            lock.close()
        elif descriptor is not None:
            _close_descriptor(descriptor)
        raise state.SupervisorError(f'cannot acquire operation lock: {error}') from error


def adopt_operation_lock(descriptor: int, paths: state.OperationPaths) -> BinaryIO:
    if fcntl is None:
        _close_descriptor(descriptor)
        raise state.SupervisorError('the deployment supervisor requires POSIX flock support')
    probe: Optional[int] = None
    try:
        inherited = validate_opened_owned_regular(descriptor, paths.operation_lock)
        flags = os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0)
        probe = os.open(paths.operation_lock, flags)
        observed = validate_opened_owned_regular(probe, paths.operation_lock)
        if (inherited.st_dev, inherited.st_ino) != (observed.st_dev, observed.st_ino):
            raise state.SupervisorError('inherited operation lock changed before adoption')
        try:
            # A separately opened shared probe only blocks when the inherited
            # open-file description already owns the required exclusive lock.
            fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            fcntl.flock(probe, fcntl.LOCK_UN)
            raise state.SupervisorError('inherited operation lock was not already held')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        validate_opened_owned_regular(descriptor, paths.operation_lock)
        lock = os.fdopen(descriptor, 'a+b', buffering=0)
        descriptor = -1
        return lock
    except BlockingIOError as error:
        raise state.SupervisorError('inherited descriptor does not own the operation lock') from error
    except OSError as error:
        raise state.SupervisorError(f'inherited operation lock is invalid: {error}') from error
    finally:
        if probe is not None:
            _close_descriptor(probe)
        if descriptor >= 0:
            _close_descriptor(descriptor)

def safe_unlink(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        raise state.SupervisorError(f'cannot inspect cleanup target {path}: {error}') from error
    lstat_regular(path, require_owner=path.parent == state.TMP_ROOT)
    try:
        path.unlink()
    except OSError as error:
        raise state.SupervisorError(f'cannot remove cleanup target {path}: {error}') from error
