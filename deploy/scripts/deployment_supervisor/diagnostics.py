"""Bounded, redacted reporting for a stopped deployment worker."""

from __future__ import annotations

import re
import sys

from . import security, state


_ANSI_ESCAPE_RE = re.compile(
    r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))'
)
_SECRET_VALUE_RE = re.compile(
    r'(?i)(?:bearer\s+\S+|basic\s+\S+|github_pat_\S+|gh[pousr]_\S+|'
    r'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|'
    r'[a-z][a-z0-9+.-]*://[^\s/:@]+:[^\s/@]+@)'
)
_ENV_ASSIGNMENT_RE = re.compile(r'\b[A-Za-z_][A-Za-z0-9_]*=')
_SENSITIVE_MARKERS = (
    'authorization', 'cookie', 'credential', 'password', 'passwd', 'secret',
    'token', 'api_key', 'api-key', 'api key', 'private_key', 'private key',
    'database_url', 'redis_url', 'dsn=',
)


def sanitized_worker_log(raw: bytes, *, max_output_bytes: int) -> str:
    """Render an inert, redacted tail of an untrusted deployment log."""

    if max_output_bytes <= 0:
        raise state.SupervisorError('diagnostic log size limit must be positive')
    lines: list[str] = []
    inside_private_key = False
    for original in raw.decode('utf-8', errors='replace').splitlines():
        line = _ANSI_ESCAPE_RE.sub('', original)
        line = ''.join(character if character.isprintable() else '�' for character in line)
        lowered = line.casefold()
        if '-----begin ' in lowered and 'private key-----' in lowered:
            inside_private_key = True
            lines.append('| [REDACTED private key material]')
            continue
        if inside_private_key:
            if '-----end ' in lowered and 'private key-----' in lowered:
                inside_private_key = False
            continue
        if (
            _ENV_ASSIGNMENT_RE.search(line)
            or any(marker in lowered for marker in _SENSITIVE_MARKERS)
            or _SECRET_VALUE_RE.search(line)
        ):
            line = '[REDACTED sensitive line]'
        lines.append(f'| {line}')
    if not lines:
        lines.append('| [worker log is empty]')

    selected: list[bytes] = []
    used = 0
    omitted = False
    for line in reversed(lines):
        rendered = f'{line}\n'.encode('utf-8')
        if len(rendered) > max_output_bytes - used:
            omitted = True
            break
        selected.append(rendered)
        used += len(rendered)
    if omitted:
        marker = b'| [earlier sanitized worker log omitted]\n'
        while selected and used + len(marker) > max_output_bytes:
            used -= len(selected.pop())
        if len(marker) <= max_output_bytes - used:
            selected.append(marker)
    return b''.join(reversed(selected)).decode('utf-8')


def report_failure_log(
    operation_id: str,
    version: str,
    expected_control_plane_sha256: str,
) -> int:
    paths = state.operation_paths(operation_id)
    version = state.require_version(version)
    expected_control_plane_sha256 = state.require_control_plane_sha256(
        expected_control_plane_sha256
    )
    operation_lock = security.acquire_operation_lock(paths, nonblocking=True)
    try:
        state.validate_launch_payload(
            security.read_json_file(paths.launch_state),
            paths,
            version,
            expected_control_plane_sha256,
        )
        if paths.status.exists() or paths.status.is_symlink():
            payload = state.validate_worker_status(
                security.read_json_file(paths.status),
                paths,
                version,
                expected_control_plane_sha256,
            )
            if payload['exit_code'] == 0:
                raise state.SupervisorError('refusing diagnostics for a successful worker')
        raw = security.secure_read_bytes(paths.log, max_bytes=state.MAX_WORKER_LOG_BYTES)
        if len(raw) > state.MAX_WORKER_LOG_BYTES:
            raise state.SupervisorError('worker log exceeds its size limit')
    finally:
        operation_lock.close()
    print('sanitized deployment worker failure log:')
    sys.stdout.write(
        sanitized_worker_log(
            raw,
            max_output_bytes=state.MAX_DIAGNOSTIC_LOG_BYTES,
        )
    )
    return 0
