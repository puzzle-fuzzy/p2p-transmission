from __future__ import annotations

import io
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

from deployment_supervisor import cli, state
from deployment_supervisor_test_support import (
    CONTROL_PLANE_SHA256,
    OPERATION_ID,
    VERSION,
)


def action_arguments(action: str) -> list[str]:
    return [
        action,
        '--operation-id',
        OPERATION_ID,
        '--version',
        VERSION,
        '--expected-control-plane-sha256',
        CONTROL_PLANE_SHA256,
    ]


class DeploymentSupervisorCliTests(unittest.TestCase):
    def test_start_binds_the_exact_running_entrypoint(self) -> None:
        entrypoint = Path('/tmp/fixed-supervisor.py')
        with patch.object(cli.worker, 'start_worker', return_value=0) as start:
            self.assertEqual(cli.main(action_arguments('start'), entrypoint=entrypoint), 0)
        start.assert_called_once_with(
            OPERATION_ID,
            VERSION,
            CONTROL_PLANE_SHA256,
            entrypoint=entrypoint,
        )

    def test_hidden_worker_dispatch_preserves_the_worker_result(self) -> None:
        arguments = [
            *action_arguments('_worker'),
            '--operation-lock-fd',
            '91',
        ]
        with patch.object(cli.worker, 'run_worker', return_value=17) as run:
            self.assertEqual(cli.main(arguments), 17)
        run.assert_called_once_with(OPERATION_ID, VERSION, CONTROL_PLANE_SHA256, 91)

    def test_supervisor_errors_are_reported_as_cli_failure(self) -> None:
        with (
            patch.object(
                cli.monitor,
                'cleanup_operation',
                side_effect=state.SupervisorError('unsafe state'),
            ),
            redirect_stderr(io.StringIO()) as stderr,
        ):
            self.assertEqual(cli.main(action_arguments('cleanup')), 1)
        self.assertIn('unsafe state', stderr.getvalue())


if __name__ == '__main__':
    unittest.main()
