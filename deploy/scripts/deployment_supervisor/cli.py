"""Stable command-line interface for the deployment supervisor."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional

from . import diagnostics, monitor, state, worker


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest='action', required=True)

    start_parser = subparsers.add_parser('start')
    start_parser.add_argument('--operation-id', required=True)
    start_parser.add_argument('--version', required=True)
    start_parser.add_argument('--expected-control-plane-sha256', required=True)

    wait_parser = subparsers.add_parser('wait')
    wait_parser.add_argument('--operation-id', required=True)
    wait_parser.add_argument('--version', required=True)
    wait_parser.add_argument('--expected-control-plane-sha256', required=True)
    wait_parser.add_argument('--timeout', type=float, default=900.0)
    wait_parser.add_argument('--poll-interval', type=float, default=1.0)

    failure_log_parser = subparsers.add_parser('failure-log')
    failure_log_parser.add_argument('--operation-id', required=True)
    failure_log_parser.add_argument('--version', required=True)
    failure_log_parser.add_argument('--expected-control-plane-sha256', required=True)

    cleanup_parser = subparsers.add_parser('cleanup')
    cleanup_parser.add_argument('--operation-id', required=True)
    cleanup_parser.add_argument('--version', required=True)
    cleanup_parser.add_argument('--expected-control-plane-sha256', required=True)

    return parser


def main(
    argv: Optional[list[str]] = None,
    *,
    entrypoint: Optional[Path] = None,
) -> int:
    entrypoint = Path(sys.argv[0]) if entrypoint is None else entrypoint
    raw_arguments = list(sys.argv[1:] if argv is None else argv)
    if raw_arguments[:1] == ['_worker']:
        worker_parser = argparse.ArgumentParser(add_help=False)
        worker_parser.add_argument('_worker')
        worker_parser.add_argument('--operation-id', required=True)
        worker_parser.add_argument('--operation-lock-fd', required=True, type=int)
        worker_parser.add_argument('--version', required=True)
        worker_parser.add_argument('--expected-control-plane-sha256', required=True)
        arguments = worker_parser.parse_args(raw_arguments)
    else:
        arguments = build_parser().parse_args(raw_arguments)
    try:
        if getattr(arguments, '_worker', None) == '_worker':
            return worker.run_worker(
                arguments.operation_id,
                arguments.version,
                arguments.expected_control_plane_sha256,
                arguments.operation_lock_fd,
            )
        action = getattr(arguments, 'action', None)
        if action == 'start':
            return worker.start_worker(
                arguments.operation_id,
                arguments.version,
                arguments.expected_control_plane_sha256,
                entrypoint=entrypoint,
            )
        if action == 'wait':
            return monitor.wait_for_worker(
                arguments.operation_id,
                arguments.version,
                arguments.expected_control_plane_sha256,
                timeout=arguments.timeout,
                poll_interval=arguments.poll_interval,
            )
        if action == 'failure-log':
            return diagnostics.report_failure_log(
                arguments.operation_id,
                arguments.version,
                arguments.expected_control_plane_sha256,
            )
        if action == 'cleanup':
            return monitor.cleanup_operation(
                arguments.operation_id,
                arguments.version,
                arguments.expected_control_plane_sha256,
            )
        raise state.SupervisorError(f'unsupported action: {action}')
    except state.SupervisorError as error:
        print(str(error), file=sys.stderr)
        return 1
