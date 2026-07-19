from __future__ import annotations

import os
import sqlite3
import stat
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from deploy_control_plane import common
from deploy_control_plane import offsite_backup as offsite_ops


class ControlPlaneOffsiteBackupTests(unittest.TestCase):
    def test_encrypts_uploads_downloads_and_restore_drills_before_reuse(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backups = root / 'deploy/production/backups'
            backups.mkdir(parents=True)
            backup = backups / 'control-20260719T000000Z-test.sqlite3'
            with closing(sqlite3.connect(backup)) as database:
                database.execute('CREATE TABLE rooms (code TEXT PRIMARY KEY)')
                database.execute('INSERT INTO rooms VALUES (?)', ('OFFSITE',))
                database.commit()
            identity = root / 'backup.agekey'
            identity.write_text('AGE-SECRET-KEY-TEST\n', encoding='utf-8')
            os.chmod(identity, 0o600)
            config = offsite_ops.OffsiteBackupConfig(
                remote='test:production/backups',
                recipient='age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
                identity=identity,
            )
            remote_objects: dict[str, bytes] = {}

            def fake_command(command: list[str]):
                if command[0] == 'age' and '-r' in command:
                    output = Path(command[command.index('-o') + 1])
                    source = Path(command[-1])
                    output.write_bytes(b'AGE-TEST\n' + source.read_bytes())
                elif command[0] == 'age' and '-d' in command:
                    output = Path(command[command.index('-o') + 1])
                    source = Path(command[-1]).read_bytes()
                    self.assertTrue(source.startswith(b'AGE-TEST\n'))
                    output.write_bytes(source.removeprefix(b'AGE-TEST\n'))
                elif command[:2] == ['rclone', 'copyto']:
                    source, destination = command[-2:]
                    if source in remote_objects:
                        Path(destination).write_bytes(remote_objects[source])
                    else:
                        remote_objects[destination] = Path(source).read_bytes()
                else:
                    self.fail(f'unexpected command: {command}')
                return None

            original_values = (
                offsite_ops.APP_DIR,
                offsite_ops.PRODUCTION_BACKUPS,
                common.APP_DIR,
            )
            offsite_ops.APP_DIR = root
            offsite_ops.PRODUCTION_BACKUPS = backups
            common.APP_DIR = root
            try:
                with (
                    patch.object(offsite_ops, 'validate_offsite_backup_config'),
                    patch.object(offsite_ops, 'run_offsite_command', side_effect=fake_command),
                ):
                    first = offsite_ops.sync_and_drill_offsite_backup(backup, config)
                    second = offsite_ops.sync_and_drill_offsite_backup(backup, config)

                self.assertTrue(first['uploaded'])
                self.assertFalse(second['uploaded'])
                self.assertEqual(first['remote_object'], second['remote_object'])
                self.assertEqual(len(remote_objects), 1)
                self.assertGreater(first['restore_drill_bytes'], 0)
                self.assertTrue((backups / offsite_ops.OFFSITE_STATE_NAME).is_file())

                remote_objects[str(first['remote_object'])] = b'tampered'
                with (
                    patch.object(offsite_ops, 'validate_offsite_backup_config'),
                    patch.object(offsite_ops, 'run_offsite_command', side_effect=fake_command),
                    self.assertRaisesRegex(SystemExit, 'size does not match|hash does not match'),
                ):
                    offsite_ops.sync_and_drill_offsite_backup(backup, config)
            finally:
                (
                    offsite_ops.APP_DIR,
                    offsite_ops.PRODUCTION_BACKUPS,
                    common.APP_DIR,
                ) = original_values

    @unittest.skipIf(os.name == 'nt', 'root ownership is POSIX-only')
    def test_accepts_a_root_owned_identity_with_exact_permissions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            identity = Path(directory) / 'backup.agekey'
            identity.touch()
            config = offsite_ops.OffsiteBackupConfig(
                remote='test:production/backups',
                recipient='age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
                identity=identity,
            )
            metadata = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0)
            with patch.object(Path, 'stat', return_value=metadata):
                offsite_ops.validate_offsite_backup_config(config)

    @unittest.skipIf(os.name == 'nt', 'root ownership is POSIX-only')
    def test_rejects_a_non_root_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            identity = Path(directory) / 'backup.agekey'
            identity.touch()
            os.chmod(identity, 0o600)
            config = offsite_ops.OffsiteBackupConfig(
                remote='test:production/backups',
                recipient='age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
                identity=identity,
            )
            metadata = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=1000)
            with (
                patch.object(Path, 'stat', return_value=metadata),
                self.assertRaisesRegex(SystemExit, 'root-owned'),
            ):
                offsite_ops.validate_offsite_backup_config(config)

    def test_rejects_traversal_in_the_remote_prefix(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            identity = Path(directory) / 'backup.agekey'
            identity.touch()
            os.chmod(identity, 0o600)
            config = offsite_ops.OffsiteBackupConfig(
                remote='test:production/../escape',
                recipient='age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
                identity=identity,
            )
            with self.assertRaisesRegex(SystemExit, 'unsafe'):
                offsite_ops.validate_offsite_backup_config(config)


if __name__ == '__main__':
    unittest.main()
