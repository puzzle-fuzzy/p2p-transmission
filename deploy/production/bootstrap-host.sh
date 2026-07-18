#!/bin/bash
set -Eeuo pipefail

readonly PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH

# Idempotently prepare the one-host production deployment boundary. This script
# intentionally does not install Docker, Nginx, TLS certificates or coturn.

umask 077

readonly DEPLOY_USER='p2p-deploy'
readonly DEPLOY_GROUP='p2p-deploy'
readonly DEPLOY_HOME='/var/lib/p2p-deploy'
readonly APP_ROOT='/opt/p2p-transmission'
readonly WRAPPER='/usr/local/sbin/p2p-transmission-deploy'
readonly HELPER_DIR='/usr/local/libexec/p2p-transmission'
readonly CONTROL_PLANE_VERSIONS="$HELPER_DIR/control-plane-versions"
readonly CONTROL_PLANE_CURRENT="$HELPER_DIR/current"
readonly HELPER="$CONTROL_PLANE_CURRENT/deploy-release.py"
readonly UNSUPPORTED_STANDALONE_HELPER="$HELPER_DIR/deploy-release.py"
readonly UNSUPPORTED_STANDALONE_PACKAGE="$HELPER_DIR/deploy_control_plane"
readonly SUDOERS_FILE='/etc/sudoers.d/p2p-transmission-deploy'
readonly SSHD_DROP_IN='/etc/ssh/sshd_config.d/60-p2p-deploy.conf'

MODE='apply'
AUTHORIZED_KEY_FILE=''
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"

usage() {
  cat <<'EOF'
Usage:
  sudo deploy/production/bootstrap-host.sh \
    --authorized-key-file /root/p2p-deploy.pub
  sudo deploy/production/bootstrap-host.sh --check

Options:
  --authorized-key-file PATH  Install one dedicated Ed25519 public key. An
                              existing different authorized_keys is preserved
                              and causes a safe failure.
  --source-root PATH          Trusted, clean Git checkout to seed a new
                              /opt/p2p-transmission (default: repository root).
  --check                     Make no changes; fail when the host drifts.
  -h, --help                  Show this help.

The script never replaces deploy/production/.env or files under data/. It does
not reload sshd; validate a second SSH session before reloading it explicitly.
EOF
}

die() {
  printf 'bootstrap-host: %s\n' "$*" >&2
  exit 1
}

note() {
  printf 'bootstrap-host: %s\n' "$*"
}

while (($#)); do
  case "$1" in
    --authorized-key-file)
      (($# >= 2)) || die '--authorized-key-file requires a path'
      AUTHORIZED_KEY_FILE="$2"
      shift 2
      ;;
    --source-root)
      (($# >= 2)) || die '--source-root requires a path'
      SOURCE_ROOT="$2"
      shift 2
      ;;
    --check)
      MODE='check'
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unsupported argument: $1"
      ;;
  esac
done

[[ "$EUID" -eq 0 ]] || die 'run as root (sudo is required even for --check)'
SOURCE_ROOT="$(cd -- "$SOURCE_ROOT" 2>/dev/null && pwd -P)" || \
  die 'source root does not exist'

WRAPPER_SOURCE="$SOURCE_ROOT/deploy/scripts/p2p-transmission-deploy.sh"
HELPER_SOURCE="$SOURCE_ROOT/deploy/scripts/deploy-release.py"
CONTROL_PLANE_SOURCE="$SOURCE_ROOT/deploy/scripts/deploy_control_plane"
SSHD_SOURCE="$SOURCE_ROOT/deploy/production/ssh/60-p2p-deploy.conf"
SUDOERS_SOURCE="$SOURCE_ROOT/deploy/production/sudoers/p2p-transmission-deploy"
ENV_EXAMPLE_SOURCE="$SOURCE_ROOT/deploy/production/.env.example"
TRUSTED_SOURCE_ROOT=''
TRUSTED_SOURCE_ARCHIVE=''
TRUSTED_AUTHORIZED_KEY=''
readonly AUTHORIZED_KEYS="$DEPLOY_HOME/.ssh/authorized_keys"
readonly PRODUCTION_ENV="$APP_ROOT/deploy/production/.env"
readonly PRODUCTION_DATA="$APP_ROOT/deploy/production/data"
readonly PRODUCTION_BACKUPS="$APP_ROOT/deploy/production/backups"
readonly PRODUCTION_ROLLBACK="$APP_ROOT/deploy/production/rollback"
readonly SOURCE_MANIFEST="$APP_ROOT/deploy/production/source-files.json"
readonly PENDING_RELEASE="$PRODUCTION_ROLLBACK/pending.json"
readonly -a CONTROL_PLANE_MODULES=(
  '__init__.py'
  'artifacts.py'
  'capacity.py'
  'cli.py'
  'common.py'
  'database.py'
  'docker_archive.py'
  'manifest.py'
  'oci_archive.py'
  'release_state.py'
  'runtime.py'
)

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

for command_name in awk chmod chown cmp cp cut flock getent git id install ln mktemp mv python3 readlink rm rmdir sshd ssh-keygen stat sudo tar visudo; do
  require_command "$command_name"
done
if [[ "$MODE" == 'apply' ]]; then
  for command_name in groupadd useradd usermod; do
    require_command "$command_name"
  done
fi

reject_linklike() {
  local path="$1"
  [[ ! -L "$path" ]] || die "refusing symbolic link: $path"
}

assert_regular_file() {
  local path="$1"
  reject_linklike "$path"
  [[ -f "$path" ]] || die "required regular file is missing: $path"
}

assert_root_controlled() {
  local path="$1"
  local owner group mode
  reject_linklike "$path"
  [[ -e "$path" ]] || die "required path is missing: $path"
  owner="$(stat -c '%U' -- "$path")"
  group="$(stat -c '%G' -- "$path")"
  mode="$(stat -c '%a' -- "$path")"
  [[ "$owner" == 'root' && "$group" == 'root' ]] || \
    die "path must be owned by root:root: $path"
  (( (8#$mode & 0022) == 0 )) || \
    die "root-controlled path is group/world writable: $path ($mode)"
}

assert_mode() {
  local path="$1"
  local expected="$2"
  local actual
  actual="$(stat -c '%a' -- "$path")"
  [[ "$actual" == "$expected" ]] || \
    die "unexpected mode for $path: expected $expected, got $actual"
}

assert_managed_file() {
  local source="$1"
  local target="$2"
  local mode="$3"
  assert_regular_file "$target"
  assert_root_controlled "$target"
  assert_mode "$target" "$mode"
  cmp -s -- "$source" "$target" || die "managed file drifted: $target"
}

fsync_regular_file() {
  local path="$1"
  python3 -I -B -X utf8 - "$path" <<'PY' || \
    die "failed to persist regular file: $path"
import os
import stat
import sys

path = sys.argv[1]
flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
descriptor = os.open(path, flags)
try:
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise OSError('path is not a single-linked regular file')
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

fsync_directory() {
  local path="$1"
  python3 -I -B -X utf8 - "$path" <<'PY' || \
    die "failed to persist directory: $path"
import os
import stat
import sys

path = sys.argv[1]
flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
descriptor = os.open(path, flags)
try:
    metadata = os.fstat(descriptor)
    if not stat.S_ISDIR(metadata.st_mode):
        raise OSError('path is not a directory')
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

atomic_install() {
  local source="$1"
  local target="$2"
  local mode="$3"
  local target_dir temporary
  target_dir="$(dirname -- "$target")"
  reject_linklike "$target_dir"
  install -d -o root -g root -m 0755 -- "$target_dir"
  reject_linklike "$target"
  if [[ -e "$target" && ! -f "$target" ]]; then
    die "refusing to replace non-regular file: $target"
  fi
  if [[ -e "$target" ]]; then
    assert_root_controlled "$target"
  fi
  temporary="$(mktemp "$target_dir/.bootstrap-host.XXXXXX")"
  install -o root -g root -m "$mode" -- "$source" "$temporary"
  fsync_regular_file "$temporary"
  mv -fT -- "$temporary" "$target"
  fsync_directory "$target_dir"
}

control_plane_source_sha256() {
  python3 -I -B -X utf8 "$HELPER_SOURCE" control-plane-manifest --format sha256
}

assert_control_plane_version() {
  local digest="$1"
  local version_root="$CONTROL_PLANE_VERSIONS/$digest"
  local entrypoint="$version_root/deploy-release.py"
  local package_root="$version_root/deploy_control_plane"
  local module
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die 'control-plane manifest digest is invalid'
  reject_linklike "$version_root"
  reject_linklike "$package_root"
  [[ -d "$version_root" && -d "$package_root" ]] || \
    die "installed control-plane version is missing: $version_root"
  assert_root_controlled "$version_root"
  assert_root_controlled "$package_root"
  assert_mode "$version_root" '555'
  assert_mode "$package_root" '555'
  assert_managed_file "$HELPER_SOURCE" "$entrypoint" '444'
  for module in "${CONTROL_PLANE_MODULES[@]}"; do
    assert_managed_file "$CONTROL_PLANE_SOURCE/$module" "$package_root/$module" '444'
  done
  local entry_sets_match
  entry_sets_match="$(python3 -B -X utf8 - \
    "$version_root" "$package_root" "${CONTROL_PLANE_MODULES[@]}" <<'PY'
import sys
from pathlib import Path

version_root = Path(sys.argv[1])
package_root = Path(sys.argv[2])
expected_modules = set(sys.argv[3:])
version_entries = {path.name for path in version_root.iterdir()}
package_entries = {path.name for path in package_root.iterdir()}
print(
    1
    if version_entries == {'deploy-release.py', 'deploy_control_plane'}
    and package_entries == expected_modules
    else 0
)
PY
)"
  [[ "$entry_sets_match" == '1' ]] || \
    die "installed control-plane version has unexpected entries: $version_root"
}

fsync_control_plane_version() {
  local version_root="$1"
  local package_root="$version_root/deploy_control_plane"
  local module
  fsync_regular_file "$version_root/deploy-release.py"
  for module in "${CONTROL_PLANE_MODULES[@]}"; do
    fsync_regular_file "$package_root/$module"
  done
  fsync_directory "$package_root"
  fsync_directory "$version_root"
}

install_control_plane_bundle() {
  local digest version_root package_root temporary pointer_tmp module
  digest="$(control_plane_source_sha256)"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die 'source control-plane manifest digest is invalid'
  reject_linklike "$CONTROL_PLANE_VERSIONS"
  install -d -o root -g root -m 0555 -- "$CONTROL_PLANE_VERSIONS"
  assert_root_controlled "$CONTROL_PLANE_VERSIONS"
  assert_mode "$CONTROL_PLANE_VERSIONS" '555'
  version_root="$CONTROL_PLANE_VERSIONS/$digest"
  package_root="$version_root/deploy_control_plane"
  if [[ -e "$version_root" || -L "$version_root" ]]; then
    assert_control_plane_version "$digest"
  else
    temporary="$(mktemp -d "$CONTROL_PLANE_VERSIONS/.bootstrap-control-plane.XXXXXX")"
    reject_linklike "$temporary"
    install -d -o root -g root -m 0755 -- "$temporary/deploy_control_plane"
    install -o root -g root -m 0444 -- \
      "$HELPER_SOURCE" "$temporary/deploy-release.py"
    for module in "${CONTROL_PLANE_MODULES[@]}"; do
      install -o root -g root -m 0444 -- \
        "$CONTROL_PLANE_SOURCE/$module" "$temporary/deploy_control_plane/$module"
    done
    chmod 0555 "$temporary/deploy_control_plane" "$temporary"
    fsync_control_plane_version "$temporary"
    mv -- "$temporary" "$version_root"
    fsync_directory "$CONTROL_PLANE_VERSIONS"
    assert_control_plane_version "$digest"
  fi

  fsync_control_plane_version "$version_root"
  fsync_directory "$CONTROL_PLANE_VERSIONS"

  pointer_tmp="$(mktemp "$HELPER_DIR/.control-plane-current.XXXXXX")"
  rm -f -- "$pointer_tmp"
  ln -s "control-plane-versions/$digest" "$pointer_tmp"
  chown -h root:root "$pointer_tmp"
  if [[ -e "$CONTROL_PLANE_CURRENT" || -L "$CONTROL_PLANE_CURRENT" ]]; then
    if [[ ! -L "$CONTROL_PLANE_CURRENT" ]]; then
      rm -f -- "$pointer_tmp"
      die "refusing to replace non-symbolic control-plane pointer: $CONTROL_PLANE_CURRENT"
    fi
    if [[ "$(stat -c '%U:%G' -- "$CONTROL_PLANE_CURRENT")" != 'root:root' ]]; then
      rm -f -- "$pointer_tmp"
      die 'installed control-plane current pointer must be root-owned'
    fi
  fi
  mv -fT -- "$pointer_tmp" "$CONTROL_PLANE_CURRENT"
  fsync_directory "$HELPER_DIR"
  printf '%s\n' "$digest"
}

check_control_plane_bundle() {
  local digest target expected_target
  digest="$(control_plane_source_sha256)"
  assert_root_controlled "$HELPER_DIR"
  assert_mode "$HELPER_DIR" '755'
  assert_root_controlled "$CONTROL_PLANE_VERSIONS"
  assert_mode "$CONTROL_PLANE_VERSIONS" '555'
  [[ -L "$CONTROL_PLANE_CURRENT" ]] || \
    die "installed control-plane current pointer is missing or unsafe: $CONTROL_PLANE_CURRENT"
  [[ "$(stat -c '%U:%G' -- "$CONTROL_PLANE_CURRENT")" == 'root:root' ]] || \
    die 'installed control-plane current pointer must be root-owned'
  target="$(readlink -f -- "$CONTROL_PLANE_CURRENT")"
  expected_target="$CONTROL_PLANE_VERSIONS/$digest"
  [[ "$target" == "$expected_target" ]] || \
    die 'installed control-plane current pointer does not match the trusted source'
  assert_control_plane_version "$digest"
  assert_managed_file "$HELPER_SOURCE" "$HELPER" '444'
  [[ ! -e "$UNSUPPORTED_STANDALONE_HELPER" && ! -L "$UNSUPPORTED_STANDALONE_HELPER" ]] || \
    die "unsupported standalone control-plane entry exists: $UNSUPPORTED_STANDALONE_HELPER"
  [[ ! -e "$UNSUPPORTED_STANDALONE_PACKAGE" && ! -L "$UNSUPPORTED_STANDALONE_PACKAGE" ]] || \
    die "unsupported standalone control-plane package exists: $UNSUPPORTED_STANDALONE_PACKAGE"
  "$WRAPPER" control-plane-status --expected-sha256 "$digest" >/dev/null
}

acquire_bootstrap_control_plane_lock() {
  local lock_path="$PRODUCTION_ROLLBACK/.control-plane.lock"
  if [[ -e "$lock_path" || -L "$lock_path" ]]; then
    assert_regular_file "$lock_path"
    assert_root_controlled "$lock_path"
    assert_mode "$lock_path" '600'
  fi
  exec {CONTROL_PLANE_LOCK_FD}>"$lock_path"
  chown root:root "$lock_path"
  chmod 0600 "$lock_path"
  flock -n "$CONTROL_PLANE_LOCK_FD" || \
    die 'another production control-plane operation is active'
}

release_bootstrap_control_plane_lock() {
  if [[ -n "${CONTROL_PLANE_LOCK_FD:-}" ]]; then
    flock -u "$CONTROL_PLANE_LOCK_FD"
    exec {CONTROL_PLANE_LOCK_FD}>&-
  fi
}

assert_no_pending_release_for_control_plane_update() {
  [[ ! -e "$PENDING_RELEASE" && ! -L "$PENDING_RELEASE" ]] || \
    die 'cannot update the control plane while a release is pending; finalize or rollback it first'
}

trusted_git() {
  /usr/bin/env -i \
    PATH="$PATH" \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    HOME=/nonexistent \
    XDG_CONFIG_HOME=/nonexistent \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_ATTR_NOSYSTEM=1 \
    git -C "$SOURCE_ROOT" "$@"
}

cleanup_trusted_bootstrap_inputs() {
  if [[ "$TRUSTED_SOURCE_ROOT" == /root/.p2p-transmission-source.* \
    && -d "$TRUSTED_SOURCE_ROOT" && ! -L "$TRUSTED_SOURCE_ROOT" ]]; then
    rm -rf --one-file-system -- "$TRUSTED_SOURCE_ROOT"
  fi
  if [[ "$TRUSTED_SOURCE_ARCHIVE" == /root/.p2p-transmission-source.* \
    && -f "$TRUSTED_SOURCE_ARCHIVE" && ! -L "$TRUSTED_SOURCE_ARCHIVE" ]]; then
    rm -f -- "$TRUSTED_SOURCE_ARCHIVE"
  fi
  if [[ "$TRUSTED_AUTHORIZED_KEY" == /root/.p2p-transmission-key.* \
    && -f "$TRUSTED_AUTHORIZED_KEY" && ! -L "$TRUSTED_AUTHORIZED_KEY" ]]; then
    rm -f -- "$TRUSTED_AUTHORIZED_KEY"
  fi
}

trap cleanup_trusted_bootstrap_inputs EXIT

activate_trusted_source_root() {
  WRAPPER_SOURCE="$TRUSTED_SOURCE_ROOT/deploy/scripts/p2p-transmission-deploy.sh"
  HELPER_SOURCE="$TRUSTED_SOURCE_ROOT/deploy/scripts/deploy-release.py"
  CONTROL_PLANE_SOURCE="$TRUSTED_SOURCE_ROOT/deploy/scripts/deploy_control_plane"
  SSHD_SOURCE="$TRUSTED_SOURCE_ROOT/deploy/production/ssh/60-p2p-deploy.conf"
  SUDOERS_SOURCE="$TRUSTED_SOURCE_ROOT/deploy/production/sudoers/p2p-transmission-deploy"
  ENV_EXAMPLE_SOURCE="$TRUSTED_SOURCE_ROOT/deploy/production/.env.example"
}

assert_trusted_source_inputs() {
  local source_file module
  for source_file in \
    "$WRAPPER_SOURCE" \
    "$HELPER_SOURCE" \
    "$SSHD_SOURCE" \
    "$SUDOERS_SOURCE" \
    "$ENV_EXAMPLE_SOURCE"; do
    [[ -f "$source_file" && ! -L "$source_file" ]] || \
      die "trusted source file is missing or unsafe: $source_file"
    assert_root_controlled "$source_file"
  done
  [[ -d "$CONTROL_PLANE_SOURCE" && ! -L "$CONTROL_PLANE_SOURCE" ]] || \
    die "trusted control-plane package is missing or unsafe: $CONTROL_PLANE_SOURCE"
  assert_root_controlled "$CONTROL_PLANE_SOURCE"
  for module in "${CONTROL_PLANE_MODULES[@]}"; do
    source_file="$CONTROL_PLANE_SOURCE/$module"
    [[ -f "$source_file" && ! -L "$source_file" ]] || \
      die "trusted control-plane module is missing or unsafe: $source_file"
    assert_root_controlled "$source_file"
  done
}

validate_trusted_source_root() {
  local git_root dirty relative module
  local -a consumed_relative=(
    'deploy/production/bootstrap-host.sh'
    'deploy/production/.env.example'
    'deploy/production/ssh/60-p2p-deploy.conf'
    'deploy/production/sudoers/p2p-transmission-deploy'
    'deploy/scripts/deploy-release.py'
    'deploy/scripts/p2p-transmission-deploy.sh'
  )
  for module in "${CONTROL_PLANE_MODULES[@]}"; do
    consumed_relative+=("deploy/scripts/deploy_control_plane/$module")
  done

  python3 -I -B -X utf8 - "$SOURCE_ROOT" \
    "${consumed_relative[@]}" <<'PY' || \
    die 'bootstrap source ownership boundary is unsafe'
import os
import stat
import sys
from pathlib import Path

source_root = Path(sys.argv[1])
consumed = tuple(sys.argv[2:])


def metadata(path: Path) -> os.stat_result:
    try:
        return path.lstat()
    except OSError as error:
        raise SystemExit(f'missing trusted path {path}: {error}') from error


def require_root_directory(path: Path) -> None:
    value = metadata(path)
    if (
        stat.S_ISLNK(value.st_mode)
        or not stat.S_ISDIR(value.st_mode)
        or value.st_uid != 0
        or value.st_gid != 0
        or stat.S_IMODE(value.st_mode) & 0o022
    ):
        raise SystemExit(f'unsafe trusted directory: {path}')


def require_root_file(path: Path) -> None:
    value = metadata(path)
    if (
        stat.S_ISLNK(value.st_mode)
        or not stat.S_ISREG(value.st_mode)
        or value.st_uid != 0
        or value.st_gid != 0
        or value.st_nlink != 1
        or stat.S_IMODE(value.st_mode) & 0o022
    ):
        raise SystemExit(f'unsafe trusted file: {path}')


cursor = Path(source_root.anchor)
require_root_directory(cursor)
for part in source_root.parts[1:]:
    cursor /= part
    require_root_directory(cursor)

for relative in consumed:
    target = source_root.joinpath(*Path(relative).parts)
    try:
        target.relative_to(source_root)
    except ValueError as error:
        raise SystemExit(f'trusted source escaped its root: {relative}') from error
    cursor = source_root
    for part in Path(relative).parts[:-1]:
        cursor /= part
        require_root_directory(cursor)
    require_root_file(target)

git_root = source_root / '.git'
require_root_directory(git_root)
for alternate in (
    git_root / 'objects/info/alternates',
    git_root / 'objects/info/http-alternates',
):
    if alternate.exists() or alternate.is_symlink():
        raise SystemExit('Git object alternates are not accepted for bootstrap')
for current, directory_names, file_names in os.walk(git_root, followlinks=False):
    current_path = Path(current)
    require_root_directory(current_path)
    for name in directory_names:
        require_root_directory(current_path / name)
    for name in file_names:
        require_root_file(current_path / name)
PY

  git_root="$(trusted_git rev-parse --show-toplevel 2>/dev/null)" || \
    die 'bootstrap source must be a trusted clean Git checkout'
  git_root="$(cd -- "$git_root" && pwd -P)"
  [[ "$git_root" == "$SOURCE_ROOT" ]] || die 'source root must be the Git worktree root'
  dirty="$(trusted_git status --porcelain=v1 --untracked-files=all --ignored=matching)"
  [[ -z "$dirty" ]] || die 'bootstrap source contains tracked or untracked changes'
  for relative in "${consumed_relative[@]}"; do
    trusted_git ls-files --error-unmatch -- "$relative" >/dev/null || \
      die "bootstrap source is not tracked by HEAD: $relative"
  done
  if ! trusted_git ls-files --stage -z | python3 -I -B -X utf8 -c '
import sys

for record in sys.stdin.buffer.read().split(b"\0"):
    if not record:
        continue
    mode = record.split(b" ", 1)[0]
    if mode not in {b"100644", b"100755"}:
        raise SystemExit("bootstrap refuses symlinks, submodules, or conflicted files")
'; then
    die 'bootstrap source contains a non-regular tracked entry'
  fi

  TRUSTED_SOURCE_ARCHIVE="$(mktemp /root/.p2p-transmission-source.XXXXXX)"
  chmod 0600 "$TRUSTED_SOURCE_ARCHIVE"
  trusted_git archive --format=tar --output="$TRUSTED_SOURCE_ARCHIVE" HEAD || \
    die 'failed to create the trusted HEAD archive'
  fsync_regular_file "$TRUSTED_SOURCE_ARCHIVE"
  fsync_directory /root

  TRUSTED_SOURCE_ROOT="$(mktemp -d /root/.p2p-transmission-source.XXXXXX)"
  chmod 0700 "$TRUSTED_SOURCE_ROOT"
  tar --extract --file="$TRUSTED_SOURCE_ARCHIVE" \
    --directory="$TRUSTED_SOURCE_ROOT" \
    --no-same-owner \
    --no-same-permissions || die 'failed to extract the trusted HEAD archive'
  python3 -I -B -X utf8 - "$TRUSTED_SOURCE_ROOT" <<'PY' || \
    die 'trusted source snapshot contains an unsafe entry'
import os
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
for current, directory_names, file_names in os.walk(root, followlinks=False):
    current_path = Path(current)
    current_metadata = current_path.lstat()
    if stat.S_ISLNK(current_metadata.st_mode) or not stat.S_ISDIR(current_metadata.st_mode):
        raise SystemExit(f'unsafe snapshot directory: {current_path}')
    os.chown(current_path, 0, 0)
    os.chmod(current_path, stat.S_IMODE(current_metadata.st_mode) & ~0o022)
    for name in directory_names:
        path = current_path / name
        value = path.lstat()
        if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
            raise SystemExit(f'unsafe snapshot directory: {path}')
    for name in file_names:
        path = current_path / name
        value = path.lstat()
        if stat.S_ISLNK(value.st_mode) or not stat.S_ISREG(value.st_mode) or value.st_nlink != 1:
            raise SystemExit(f'unsafe snapshot file: {path}')
        os.chown(path, 0, 0)
        os.chmod(path, stat.S_IMODE(value.st_mode) & ~0o022)
PY
  activate_trusted_source_root
  assert_trusted_source_inputs
}

snapshot_authorized_key_file() {
  local requested="$AUTHORIZED_KEY_FILE"
  [[ -n "$requested" ]] || return 0
  TRUSTED_AUTHORIZED_KEY="$(mktemp /root/.p2p-transmission-key.XXXXXX)"
  chmod 0600 "$TRUSTED_AUTHORIZED_KEY"
  python3 -I -B -X utf8 - "$requested" "$TRUSTED_AUTHORIZED_KEY" <<'PY' || \
    die 'authorized key source is not root-controlled or stable'
import os
import stat
import sys
from pathlib import Path

source = Path(os.path.abspath(sys.argv[1]))
destination = Path(sys.argv[2])
cursor = Path(source.anchor)
for part in source.parts[1:-1]:
    value = cursor.lstat()
    if (
        stat.S_ISLNK(value.st_mode)
        or not stat.S_ISDIR(value.st_mode)
        or value.st_uid != 0
        or value.st_gid != 0
        or stat.S_IMODE(value.st_mode) & 0o022
    ):
        raise SystemExit(f'unsafe authorized key parent: {cursor}')
    cursor /= part
value = cursor.lstat()
if (
    stat.S_ISLNK(value.st_mode)
    or not stat.S_ISDIR(value.st_mode)
    or value.st_uid != 0
    or value.st_gid != 0
    or stat.S_IMODE(value.st_mode) & 0o022
):
    raise SystemExit(f'unsafe authorized key parent: {cursor}')

flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
descriptor = os.open(source, flags)
try:
    opened = os.fstat(descriptor)
    named = source.lstat()
    if (
        not stat.S_ISREG(opened.st_mode)
        or stat.S_ISLNK(named.st_mode)
        or opened.st_dev != named.st_dev
        or opened.st_ino != named.st_ino
        or opened.st_uid != 0
        or opened.st_gid != 0
        or opened.st_nlink != 1
        or stat.S_IMODE(opened.st_mode) & 0o022
    ):
        raise SystemExit('unsafe authorized key file')
    maximum_bytes = 16 * 1024
    if opened.st_size > maximum_bytes:
        raise SystemExit('authorized key file is too large')
    chunks = []
    total = 0
    while True:
        chunk = os.read(descriptor, min(4096, maximum_bytes + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > maximum_bytes:
            raise SystemExit('authorized key file is too large')
    if total != opened.st_size:
        raise SystemExit('authorized key file changed while it was read')
    payload = b''.join(chunks)
finally:
    os.close(descriptor)

destination_flags = os.O_WRONLY | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0)
destination_descriptor = os.open(destination, destination_flags)
try:
    remaining = memoryview(payload)
    while remaining:
        written = os.write(destination_descriptor, remaining)
        if written <= 0:
            raise OSError('short authorized key snapshot write')
        remaining = remaining[written:]
    os.fsync(destination_descriptor)
finally:
    os.close(destination_descriptor)
os.chmod(destination, 0o400)
PY
  fsync_directory /root
  AUTHORIZED_KEY_FILE="$TRUSTED_AUTHORIZED_KEY"
}

validate_trusted_source_root
snapshot_authorized_key_file

ensure_deploy_account() {
  if ! getent group "$DEPLOY_GROUP" >/dev/null; then
    groupadd --system "$DEPLOY_GROUP"
  fi
  if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
    useradd \
      --system \
      --gid "$DEPLOY_GROUP" \
      --create-home \
      --home-dir "$DEPLOY_HOME" \
      --shell /bin/bash \
      "$DEPLOY_USER"
  fi
  [[ "$(getent passwd "$DEPLOY_USER" | cut -d: -f6)" == "$DEPLOY_HOME" ]] || \
    die "$DEPLOY_USER has an unexpected home directory"
  [[ "$(getent passwd "$DEPLOY_USER" | cut -d: -f7)" == '/bin/bash' ]] || \
    die "$DEPLOY_USER has an unexpected login shell"
  [[ "$(id -gn "$DEPLOY_USER")" == "$DEPLOY_GROUP" ]] || \
    die "$DEPLOY_USER has an unexpected primary group"
  local groups
  groups="$(id -Gn "$DEPLOY_USER")"
  [[ "$groups" == "$DEPLOY_GROUP" ]] || \
    die "$DEPLOY_USER must not belong to additional privileged groups: $groups"
  usermod --lock "$DEPLOY_USER"
  reject_linklike "$DEPLOY_HOME"
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 0700 -- "$DEPLOY_HOME"
  reject_linklike "$DEPLOY_HOME/.ssh"
  install -d -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" -m 0700 -- "$DEPLOY_HOME/.ssh"
}

check_deploy_account() {
  local shadow_password
  id "$DEPLOY_USER" >/dev/null 2>&1 || die "missing deployment user: $DEPLOY_USER"
  getent group "$DEPLOY_GROUP" >/dev/null || die "missing deployment group: $DEPLOY_GROUP"
  [[ "$(getent passwd "$DEPLOY_USER" | cut -d: -f6)" == "$DEPLOY_HOME" ]] || \
    die "$DEPLOY_USER has an unexpected home directory"
  [[ "$(getent passwd "$DEPLOY_USER" | cut -d: -f7)" == '/bin/bash' ]] || \
    die "$DEPLOY_USER has an unexpected login shell"
  [[ "$(id -gn "$DEPLOY_USER")" == "$DEPLOY_GROUP" ]] || \
    die "$DEPLOY_USER has an unexpected primary group"
  [[ "$(id -Gn "$DEPLOY_USER")" == "$DEPLOY_GROUP" ]] || \
    die "$DEPLOY_USER belongs to unexpected supplementary groups"
  shadow_password="$(getent shadow "$DEPLOY_USER" | cut -d: -f2)"
  [[ "$shadow_password" == '!'* || "$shadow_password" == '*'* ]] || \
    die "$DEPLOY_USER password must remain locked"
  reject_linklike "$DEPLOY_HOME"
  [[ -d "$DEPLOY_HOME" ]] || die 'deployment account home directory is missing'
  [[ "$(stat -c '%U:%G' -- "$DEPLOY_HOME")" == "$DEPLOY_USER:$DEPLOY_GROUP" ]] || \
    die 'deployment account home ownership is invalid'
  assert_mode "$DEPLOY_HOME" '700'
  reject_linklike "$DEPLOY_HOME/.ssh"
  [[ -d "$DEPLOY_HOME/.ssh" ]] || die 'deployment account .ssh directory is missing'
  [[ "$(stat -c '%U:%G' -- "$DEPLOY_HOME/.ssh")" == "$DEPLOY_USER:$DEPLOY_GROUP" ]] || \
    die 'deployment account .ssh ownership is invalid'
  assert_mode "$DEPLOY_HOME/.ssh" '700'
}

validate_public_key_file() {
  local key_file="$1"
  local line_count key
  assert_regular_file "$key_file"
  line_count="$(python3 -X utf8 - "$key_file" <<'PY'
import sys
from pathlib import Path

lines = [line for line in Path(sys.argv[1]).read_text(encoding='utf-8').splitlines() if line.strip()]
print(len(lines))
PY
)"
  [[ "$line_count" == '1' ]] || die 'authorized key input must contain exactly one non-empty line'
  IFS= read -r key < "$key_file"
  [[ "$key" == ssh-ed25519\ * ]] || die 'only a dedicated Ed25519 public key is accepted'
  ssh-keygen -l -f "$key_file" >/dev/null 2>&1 || die 'authorized key input is invalid'
}

install_authorized_key() {
  local key rendered temporary
  validate_public_key_file "$AUTHORIZED_KEY_FILE"
  IFS= read -r key < "$AUTHORIZED_KEY_FILE"
  rendered="restrict $key"
  if [[ -e "$AUTHORIZED_KEYS" || -L "$AUTHORIZED_KEYS" ]]; then
    assert_regular_file "$AUTHORIZED_KEYS"
    [[ "$(<"$AUTHORIZED_KEYS")" == "$rendered" ]] || \
      die "refusing to replace existing $AUTHORIZED_KEYS; rotate it manually from an active console session"
  else
    temporary="$(mktemp "$DEPLOY_HOME/.ssh/.authorized_keys.XXXXXX")"
    printf '%s\n' "$rendered" > "$temporary"
    chown "$DEPLOY_USER:$DEPLOY_GROUP" "$temporary"
    chmod 0600 "$temporary"
    mv -fT -- "$temporary" "$AUTHORIZED_KEYS"
  fi
}

check_authorized_key() {
  local content
  assert_regular_file "$AUTHORIZED_KEYS"
  [[ "$(stat -c '%U:%G' -- "$AUTHORIZED_KEYS")" == "$DEPLOY_USER:$DEPLOY_GROUP" ]] || \
    die 'authorized_keys ownership is invalid'
  assert_mode "$AUTHORIZED_KEYS" '600'
  content="$(<"$AUTHORIZED_KEYS")"
  [[ "$content" == 'restrict ssh-ed25519 '* && "$content" != *$'\n'* ]] || \
    die 'authorized_keys must contain one restricted Ed25519 key'
  if [[ -n "$AUTHORIZED_KEY_FILE" ]]; then
    local key
    validate_public_key_file "$AUTHORIZED_KEY_FILE"
    IFS= read -r key < "$AUTHORIZED_KEY_FILE"
    [[ "$content" == "restrict $key" ]] || die 'installed deployment key does not match the requested key'
  fi
}

validate_source_manifest() {
  assert_regular_file "$SOURCE_MANIFEST"
  assert_root_controlled "$SOURCE_MANIFEST"
  assert_mode "$SOURCE_MANIFEST" '600'
  python3 -I -B -X utf8 - "$APP_ROOT" "$SOURCE_MANIFEST" <<'PY' || \
    die 'production source manifest does not match the installed current source tree'
import json
import os
import stat
import sys
from pathlib import Path, PurePosixPath

root = Path(sys.argv[1])
manifest = Path(sys.argv[2])


def normalize(raw: str) -> str:
    if not raw or '\\' in raw:
        raise ValueError(raw)
    parts = raw.split('/')
    path = PurePosixPath(raw)
    if path.is_absolute() or any(part in {'', '.', '..'} for part in parts):
        raise ValueError(raw)
    return path.as_posix()


def protected(relative: str) -> bool:
    parts = PurePosixPath(relative).parts
    prefixes = (
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
    if not parts or parts[0] == '.git':
        return True
    if any(parts[:len(prefix)] == prefix for prefix in prefixes):
        return True
    if parts[:2] == ('deploy', 'coturn') and relative.endswith(('.pem', '.key')):
        return True
    return parts[0] == 'deploy' and (
        relative.endswith('.sqlite') or '.sqlite-' in PurePosixPath(relative).name
    )


payload = json.loads(manifest.read_text(encoding='utf-8'))
if not isinstance(payload, list) or not all(isinstance(item, str) for item in payload):
    raise SystemExit('source manifest must be a JSON string array')
normalized = [normalize(item) for item in payload]
if normalized != sorted(set(normalized)):
    raise SystemExit('source manifest must be sorted and contain unique paths')
listed = set(normalized)
if 'deploy/scripts/deploy-release.py' not in listed:
    raise SystemExit('source manifest is missing the deployment entry')

actual: set[str] = set()
for current, directory_names, file_names in os.walk(root, followlinks=False):
    current_path = Path(current)
    for name in directory_names:
        path = current_path / name
        if path.is_symlink():
            raise SystemExit(f'installed source directory is unsafe: {path}')
    for name in file_names:
        path = current_path / name
        relative = path.relative_to(root).as_posix()
        metadata = path.lstat()
        if protected(relative):
            continue
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise SystemExit(f'installed source file is unsafe: {relative}')
        actual.add(relative)

if actual != listed:
    raise SystemExit('source manifest does not describe the installed source files exactly')
PY
}

write_seed_source_manifest() {
  local root="$1"
  local manifest="$root/deploy/production/source-files.json"
  python3 -I -B -X utf8 - "$root" "$manifest" <<'PY' || \
    die 'failed to create the current source manifest'
import json
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
manifest = Path(sys.argv[2])
files = sorted(
    path.relative_to(root).as_posix()
    for path in root.rglob('*')
    if path.is_file()
)
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
descriptor = os.open(manifest, flags, 0o600)
with os.fdopen(descriptor, 'w', encoding='utf-8') as destination:
    json.dump(files, destination, ensure_ascii=False, indent=2)
    destination.write('\n')
    destination.flush()
    os.fsync(destination.fileno())
os.chmod(manifest, 0o600)
PY
  fsync_regular_file "$manifest"
  fsync_directory "$(dirname -- "$manifest")"
}

seed_release_tree() {
  if [[ -e "$SOURCE_MANIFEST" || -L "$SOURCE_MANIFEST" ]]; then
    validate_source_manifest
    return
  fi
  if [[ -e "$APP_ROOT/deploy/scripts/deploy-release.py" || \
        -L "$APP_ROOT/deploy/scripts/deploy-release.py" ]]; then
    die "existing application root has no current source manifest: $APP_ROOT"
  fi
  local temporary
  local -a existing=()
  shopt -s dotglob nullglob
  existing=("$APP_ROOT"/*)
  shopt -u dotglob nullglob
  ((${#existing[@]} == 0)) || \
    die "refusing to seed a non-empty application root without its deployment helper: $APP_ROOT"
  assert_regular_file "$TRUSTED_SOURCE_ARCHIVE"
  assert_root_controlled "$TRUSTED_SOURCE_ARCHIVE"
  assert_mode "$TRUSTED_SOURCE_ARCHIVE" '600'
  note "seeding tracked release files into $APP_ROOT"
  temporary="$(mktemp -d /opt/.p2p-transmission-bootstrap.XXXXXX)"
  [[ "$temporary" == /opt/.p2p-transmission-bootstrap.* ]] || \
    die 'temporary release directory escaped /opt'
  if ! tar --extract --file="$TRUSTED_SOURCE_ARCHIVE" \
    --directory="$temporary" --no-same-owner --no-same-permissions; then
    rm -rf --one-file-system -- "$temporary"
    die 'failed to extract the trusted release checkout'
  fi
  if [[ ! -f "$temporary/deploy/scripts/deploy-release.py" ]]; then
    rm -rf --one-file-system -- "$temporary"
    die 'trusted release checkout does not contain the deployment helper'
  fi
  write_seed_source_manifest "$temporary"
  rmdir -- "$APP_ROOT"
  mv -- "$temporary" "$APP_ROOT"
  chown root:root "$APP_ROOT"
  chmod 0755 "$APP_ROOT"
  validate_source_manifest
}

ensure_runtime_paths() {
  reject_linklike "$APP_ROOT"
  install -d -o root -g root -m 0755 -- "$APP_ROOT"
  seed_release_tree
  assert_regular_file "$APP_ROOT/deploy/scripts/deploy-release.py"
  chown root:root "$APP_ROOT/deploy/scripts/deploy-release.py"
  chmod 0755 "$APP_ROOT/deploy/scripts/deploy-release.py"
  reject_linklike "$APP_ROOT/deploy/production"
  install -d -o root -g root -m 0755 -- "$APP_ROOT/deploy/production"
  reject_linklike "$PRODUCTION_DATA"
  reject_linklike "$PRODUCTION_BACKUPS"
  reject_linklike "$PRODUCTION_ROLLBACK"
  install -d -o 10001 -g 10001 -m 0700 -- "$PRODUCTION_DATA"
  install -d -o root -g root -m 0700 -- "$PRODUCTION_BACKUPS" "$PRODUCTION_ROLLBACK"
  if [[ -e "$PRODUCTION_ENV" || -L "$PRODUCTION_ENV" ]]; then
    assert_regular_file "$PRODUCTION_ENV"
    chown root:root "$PRODUCTION_ENV"
    chmod 0600 "$PRODUCTION_ENV"
  else
    install -o root -g root -m 0600 -- "$ENV_EXAMPLE_SOURCE" "$PRODUCTION_ENV"
    note "created placeholder $PRODUCTION_ENV; replace every placeholder before starting production"
  fi
}

check_database_files() {
  local path
  for path in \
    "$PRODUCTION_DATA/control.sqlite3" \
    "$PRODUCTION_DATA/control.sqlite3-wal" \
    "$PRODUCTION_DATA/control.sqlite3-shm"; do
    if [[ -e "$path" || -L "$path" ]]; then
      assert_regular_file "$path"
      [[ "$(stat -c '%u:%g' -- "$path")" == '10001:10001' ]] || \
        die "existing database file ownership must remain 10001:10001: $path"
    fi
  done
}

check_runtime_paths() {
  [[ -d "$APP_ROOT" ]] || die "application root is missing: $APP_ROOT"
  assert_root_controlled "$APP_ROOT"
  assert_regular_file "$HELPER"
  assert_root_controlled "$HELPER"
  assert_mode "$HELPER" '444'
  [[ -d "$PRODUCTION_DATA" && ! -L "$PRODUCTION_DATA" ]] || die 'production data directory is unsafe'
  [[ "$(stat -c '%u:%g' -- "$PRODUCTION_DATA")" == '10001:10001' ]] || \
    die 'production data directory must be owned by 10001:10001'
  assert_mode "$PRODUCTION_DATA" '700'
  for path in "$PRODUCTION_BACKUPS" "$PRODUCTION_ROLLBACK"; do
    [[ -d "$path" ]] || die "runtime directory is missing: $path"
    assert_root_controlled "$path"
    assert_mode "$path" '700'
  done
  assert_regular_file "$PRODUCTION_ENV"
  assert_root_controlled "$PRODUCTION_ENV"
  assert_mode "$PRODUCTION_ENV" '600'
  validate_source_manifest
  check_database_files
}

effective_sshd_value() {
  local key="$1"
  sshd -T -C user="$DEPLOY_USER",host=localhost,addr=127.0.0.1 | \
    awk -v expected="$key" '$1 == expected && !found { print $2; found = 1 }'
}

check_sshd_policy() {
  sshd -t || die 'sshd configuration validation failed'
  local pair key expected actual
  for pair in \
    'authenticationmethods=publickey' \
    'pubkeyauthentication=yes' \
    'passwordauthentication=no' \
    'kbdinteractiveauthentication=no' \
    'permitemptypasswords=no' \
    'disableforwarding=yes' \
    'allowagentforwarding=no' \
    'allowtcpforwarding=no' \
    'allowstreamlocalforwarding=no' \
    'x11forwarding=no' \
    'permittunnel=no' \
    'permittty=no' \
    'permituserrc=no'; do
    key="${pair%%=*}"
    expected="${pair#*=}"
    actual="$(effective_sshd_value "$key")"
    [[ "$actual" == "$expected" ]] || \
      die "effective sshd policy mismatch for $key: expected $expected, got ${actual:-missing}"
  done
}

install_sshd_policy() {
  local backup=''
  if [[ -e "$SSHD_DROP_IN" || -L "$SSHD_DROP_IN" ]]; then
    assert_regular_file "$SSHD_DROP_IN"
    backup="$(mktemp /tmp/p2p-sshd-drop-in.XXXXXX)"
    cp --preserve=mode,ownership,timestamps -- "$SSHD_DROP_IN" "$backup"
  fi
  atomic_install "$SSHD_SOURCE" "$SSHD_DROP_IN" 0644
  if ! (check_sshd_policy); then
    if [[ -n "$backup" ]]; then
      install -o root -g root -m 0644 -- "$backup" "$SSHD_DROP_IN"
    else
      rm -f -- "$SSHD_DROP_IN"
    fi
    rm -f -- "$backup"
    sshd -t || true
    die 'new sshd policy was rejected and has been restored'
  fi
  rm -f -- "$backup"
}

install_sudoers_policy() {
  local backup=''
  visudo -cf "$SUDOERS_SOURCE" >/dev/null || die 'sudoers source validation failed'
  if [[ -e "$SUDOERS_FILE" || -L "$SUDOERS_FILE" ]]; then
    assert_regular_file "$SUDOERS_FILE"
    backup="$(mktemp /tmp/p2p-sudoers.XXXXXX)"
    cp --preserve=mode,ownership,timestamps -- "$SUDOERS_FILE" "$backup"
  fi
  atomic_install "$SUDOERS_SOURCE" "$SUDOERS_FILE" 0440
  if ! visudo -cf /etc/sudoers >/dev/null; then
    if [[ -n "$backup" ]]; then
      install -o root -g root -m 0440 -- "$backup" "$SUDOERS_FILE"
    else
      rm -f -- "$SUDOERS_FILE"
    fi
    rm -f -- "$backup"
    die 'installed sudoers configuration was rejected and has been restored'
  fi
  rm -f -- "$backup"
}

if [[ "$MODE" == 'apply' ]]; then
  ensure_deploy_account
  ensure_runtime_paths
  acquire_bootstrap_control_plane_lock
  assert_no_pending_release_for_control_plane_update
  if [[ -n "$AUTHORIZED_KEY_FILE" ]]; then
    install_authorized_key
  elif [[ ! -e "$AUTHORIZED_KEYS" && ! -L "$AUTHORIZED_KEYS" ]]; then
    die '--authorized-key-file is required for the first bootstrap'
  fi
  reject_linklike "$HELPER_DIR"
  install -d -o root -g root -m 0755 -- "$HELPER_DIR"
  fsync_directory "$HELPER_DIR"
  fsync_directory "$(dirname -- "$HELPER_DIR")"
  fsync_directory "$(dirname -- "$(dirname -- "$HELPER_DIR")")"
  assert_root_controlled "$HELPER_DIR"
  install_control_plane_bundle >/dev/null
  atomic_install "$WRAPPER_SOURCE" "$WRAPPER" 0755
  install_sudoers_policy
  install_sshd_policy
  release_bootstrap_control_plane_lock
fi

check_deploy_account
check_authorized_key
check_runtime_paths
assert_managed_file "$WRAPPER_SOURCE" "$WRAPPER" '755'
check_control_plane_bundle
assert_managed_file "$SUDOERS_SOURCE" "$SUDOERS_FILE" '440'
assert_managed_file "$SSHD_SOURCE" "$SSHD_DROP_IN" '644'
visudo -cf /etc/sudoers >/dev/null || die 'sudoers configuration validation failed'
check_sshd_policy
sudo -n -U "$DEPLOY_USER" -l "$WRAPPER" maintenance >/dev/null || \
  die "$DEPLOY_USER is not allowed to run fixed deployment maintenance"
if sudo -n -U "$DEPLOY_USER" -l "$WRAPPER" >/dev/null 2>&1; then
  die "$DEPLOY_USER must not be allowed to invoke the wrapper without an approved operation"
fi

note 'host deployment boundary is valid'
if [[ "$MODE" == 'apply' ]]; then
  note 'sshd was not reloaded; keep this session open, reload ssh/sshd, then verify a second key-only session'
fi
