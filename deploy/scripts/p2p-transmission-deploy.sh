#!/bin/bash
set -euo pipefail
umask 022

readonly CONTROL_PLANE_ENTRY='/usr/local/libexec/p2p-transmission/current/deploy-release.py'
if ! PHYSICAL_CONTROL_PLANE_ENTRY="$(/usr/bin/readlink -e -- "$CONTROL_PLANE_ENTRY")"; then
  printf 'deployment control-plane entry is unavailable\n' >&2
  exit 1
fi
readonly PHYSICAL_CONTROL_PLANE_ENTRY
if [[ ! "$PHYSICAL_CONTROL_PLANE_ENTRY" =~ ^/usr/local/libexec/p2p-transmission/control-plane-versions/[0-9a-f]{64}/deploy-release\.py$ ]]; then
  printf 'deployment control-plane entry escaped its version directory\n' >&2
  exit 1
fi

exec /usr/bin/env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  /usr/bin/python3 -I -B -X utf8 \
  "$PHYSICAL_CONTROL_PLANE_ENTRY" "$@"
