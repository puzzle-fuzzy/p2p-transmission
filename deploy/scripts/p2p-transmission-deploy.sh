#!/usr/bin/env bash
set -euo pipefail

exec /usr/bin/python3 /opt/p2p-transmission/deploy/scripts/deploy-release.py "$@"
