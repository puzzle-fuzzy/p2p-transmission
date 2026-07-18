from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deployment_supervisor import state


OPERATION_ID = 'a' * 40
VERSION = '2.0.1-aaaaaaaaaaaa'
CONTROL_PLANE_SHA256 = 'b' * 64


class DummyLock:
    def __init__(self, descriptor: int = 91) -> None:
        self.closed = False
        self.descriptor = descriptor

    def fileno(self) -> int:
        return self.descriptor

    def close(self) -> None:
        self.closed = True


class SupervisorTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.patchers = [
            patch.object(state, 'TMP_ROOT', self.root),
            patch.object(state, 'GLOBAL_LOCK', self.root / 'p2p-transmission-deploy.lock'),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self) -> None:
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temporary.cleanup()

    def write_owned(self, path: Path, text: str = 'fixture') -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        os.chmod(path, 0o600)

    def valid_status(self, *, exit_code: int = 0) -> dict[str, object]:
        return {
            'schema': state.SCHEMA,
            'operation_id': OPERATION_ID,
            'version': VERSION,
            'expected_control_plane_sha256': CONTROL_PLANE_SHA256,
            'exit_code': exit_code,
            'database_backup': None,
            'database_backup_not_required': True,
            'finished': True,
        }
