#!/usr/bin/env bash
# Deploy one release tag as an immutable release behind the atomic `current` symlink (issue #190),
# or roll `current` back to the release before it (issue #191).
#
# Usage: deploy.sh vMAJOR.MINOR.PATCH
#        deploy.sh --rollback vMAJOR.MINOR.PATCH
#
# Run as root from an operator checkout of the repository whose `origin` holds the release tags.
# Everything up to the symlink swap happens in a hidden staging directory; any failure there
# removes it and leaves `current` and the running services untouched.
#
# A rollback builds nothing, fetches nothing and runs no migration: it repoints `current` at a
# release already on disk and restarts the services. Migrations are forward-only and compatible
# with the code one release back only, so the target must be the release directly before the
# newest one on disk, and `current` must still name that newest release.
set -euo pipefail

readonly SEMPREC_ROOT=/opt/semprec
readonly RELEASES_DIR="$SEMPREC_ROOT/releases"
readonly CURRENT_LINK="$SEMPREC_ROOT/current"
readonly SHARED_ENV="$SEMPREC_ROOT/shared/.env"
readonly LOCK_FILE="$SEMPREC_ROOT/.deploy.lock"
readonly PROC_ROOT=/proc
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SOURCE_REPOSITORY="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly TAG_PATTERN='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

# Restarted in this order; every active `semprec-mailsync@` instance follows them.
readonly -a LONG_RUNNING_SERVICES=(
  semprec-ai-gateway.service
  semprec-api.service
  semprec-agents.service
  semprec-transcribe.service
)

staging_dir=""

fail() {
  echo "deploy.sh: $*" >&2
  exit 1
}

remove_staging() {
  if [[ -n "$staging_dir" && -d "$staging_dir" ]]; then
    rm -rf -- "$staging_dir"
  fi
}

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    fail "must run as root"
  fi
}

validate_tag_format() {
  local tag="$1"
  if [[ ! "$tag" =~ $TAG_PATTERN ]]; then
    fail "invalid release tag '$tag'; expected vMAJOR.MINOR.PATCH (see docs/operations/releases.md)"
  fi
}

require_release_tree() {
  [[ -d "$RELEASES_DIR" ]] || fail "$RELEASES_DIR is missing; run provision.sh first"
  [[ -f "$SHARED_ENV" ]] || fail "$SHARED_ENV is missing; run provision.sh first"
  if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
    fail "$CURRENT_LINK exists and is not a symlink; refusing to replace it"
  fi
}

acquire_lock() {
  exec 9>"$LOCK_FILE"
  flock --nonblock 9 || fail "another deploy is already running"
}

# Prints the commit the tag names. The tag is fetched from origin without force, so a local tag
# that differs from origin's is rejected rather than silently replaced.
resolve_release_commit() {
  local tag="$1"
  local commit

  if ! git -C "$SOURCE_REPOSITORY" fetch --quiet origin \
    "+refs/heads/main:refs/remotes/origin/main" "refs/tags/$tag:refs/tags/$tag"; then
    fail "cannot fetch tag $tag and main from origin"
  fi
  if [[ "$(git -C "$SOURCE_REPOSITORY" cat-file -t "refs/tags/$tag")" != "tag" ]]; then
    fail "$tag is not an annotated release tag"
  fi
  commit="$(git -C "$SOURCE_REPOSITORY" rev-parse --verify "refs/tags/$tag^{commit}")"
  if ! git -C "$SOURCE_REPOSITORY" merge-base --is-ancestor "$commit" refs/remotes/origin/main; then
    fail "$tag points at $commit, which is not on main"
  fi
  printf '%s\n' "$commit"
}

# The release is an export of the tagged tree, not a git checkout, so nothing can pull into it.
stage_release() {
  local tag="$1"
  local commit="$2"

  staging_dir="$(mktemp -d "$RELEASES_DIR/.$tag.partial.XXXXXX")"
  chmod 0755 "$staging_dir"
  git -C "$SOURCE_REPOSITORY" archive --format=tar "$commit" | tar -x -C "$staging_dir"
}

# Copying packages out of the store keeps the release's files from sharing inodes with it. The
# steps are chained with `&&` because `set -e` does not apply inside a subshell tested by `||`.
build_release() {
  (
    cd "$staging_dir/backend" &&
      CI=true pnpm install --frozen-lockfile --package-import-method=copy &&
      pnpm -r run build
  ) || fail "build of the staged release failed"
}

# Non-secret and release-specific, so it lives in the release; every unit loads it after the
# shared `.env`.
write_release_env() {
  local tag="$1"
  printf 'APP_VERSION=%s\n' "$tag" > "$staging_dir/release.env"
  chmod 0644 "$staging_dir/release.env"
}

# systemd reads the shared `.env` itself, exactly as it does for the units, so this script never
# reads or copies a secret. Migrations are forward-only and backward-compatible, so the release
# still serving traffic keeps working against the migrated schema.
run_migrations() {
  systemd-run --quiet --wait --pipe --collect \
    --uid=semprec --gid=semprec \
    --property=EnvironmentFile="$SHARED_ENV" \
    --working-directory="$staging_dir/backend" \
    /bin/sh -c 'DATABASE_URL="$SEMPREC_MIGRATE_DATABASE_URL" exec node packages/data/dist/db/runMigrationsCli.js' \
    || fail "migrations failed"
}

promote_release() {
  local tag="$1"
  mv -T -- "$staging_dir" "$RELEASES_DIR/$tag"
  staging_dir=""
}

# rename(2) replaces the link in one step: `current` always names a complete release.
swap_current() {
  local tag="$1"
  local next_link="$SEMPREC_ROOT/.current.next"
  ln -sfn -- "$RELEASES_DIR/$tag" "$next_link"
  mv -T -- "$next_link" "$CURRENT_LINK"
}

active_mailsync_instances() {
  systemctl list-units --plain --no-legend --state=active,activating 'semprec-mailsync@*.service' |
    awk '{print $1}'
}

restart_services() {
  local unit
  for unit in "$@"; do
    systemctl restart "$unit" || fail "$unit failed to restart after current moved"
  done
}

# Reads only APP_VERSION from each restarted process's own environment. A oneshot mailsync
# instance that already finished has no process left to report.
report_versions() {
  local tag="$1"
  shift
  local unit
  local pid
  local version
  local mismatched=0

  for unit in "$@"; do
    pid="$(systemctl show --property=MainPID --value "$unit")"
    if [[ "$pid" == "0" ]]; then
      if [[ "$unit" == semprec-mailsync@* ]]; then
        continue
      fi
      echo "$unit: not running" >&2
      mismatched=1
      continue
    fi
    version="$(tr '\0' '\n' < "$PROC_ROOT/$pid/environ" | sed -n 's/^APP_VERSION=//p')"
    echo "$unit: ${version:-<unset>}"
    if [[ "$version" != "$tag" ]]; then
      mismatched=1
    fi
  done

  if (( mismatched )); then
    fail "not every process reports $tag"
  fi
}

# Prints the release directories under releases/ (hidden staging directories excluded), oldest
# first.
releases_by_version() {
  local path
  local name
  for path in "$RELEASES_DIR"/v*; do
    name="${path##*/}"
    if [[ -d "$path" && ! -L "$path" && "$name" =~ $TAG_PATTERN ]]; then
      printf '%s\n' "$name"
    fi
  done | sort -V
}

# Refuses, before anything changes, every target except the complete release directly before the
# newest release on disk while `current` still names that newest release.
validate_rollback_target() {
  local tag="$1"
  local target="$RELEASES_DIR/$tag"
  local -a releases
  local newest
  local previous
  local current_target

  if [[ ! -d "$target" || -L "$target" ]]; then
    fail "$target is not a deployed release; a rollback only repoints current at a release already on disk"
  fi
  if ! grep -qx "APP_VERSION=$tag" "$target/release.env" 2> /dev/null; then
    fail "$target/release.env does not declare APP_VERSION=$tag; refusing an incomplete release"
  fi

  mapfile -t releases < <(releases_by_version)
  newest="${releases[-1]}"
  if (( ${#releases[@]} < 2 )); then
    fail "$newest is the only release on disk; there is no previous release to roll back to"
  fi
  previous="${releases[-2]}"
  if [[ "$tag" != "$previous" ]]; then
    fail "can only roll back to $previous, the release before the newest release $newest; migrations are compatible one release back only"
  fi

  if [[ ! -L "$CURRENT_LINK" ]]; then
    fail "$CURRENT_LINK is not a symlink; nothing to roll back"
  fi
  current_target="$(readlink -- "$CURRENT_LINK")"
  if [[ "$current_target" != "$RELEASES_DIR/$newest" ]]; then
    fail "current points at $current_target, not at the newest release $newest; nothing to roll back"
  fi
}

# Moves `current` to an already complete release and restarts every process onto it.
activate_release() {
  local tag="$1"
  local mailsync_instances
  local -a units=("${LONG_RUNNING_SERVICES[@]}")
  mailsync_instances="$(active_mailsync_instances)"
  if [[ -n "$mailsync_instances" ]]; then
    local -a instances
    mapfile -t instances <<< "$mailsync_instances"
    units+=("${instances[@]}")
  fi

  swap_current "$tag"
  restart_services "${units[@]}"
  report_versions "$tag" "${units[@]}"
}

deploy() {
  local tag="$1"
  local commit

  if [[ -e "$RELEASES_DIR/$tag" || -L "$RELEASES_DIR/$tag" ]]; then
    fail "$RELEASES_DIR/$tag already exists; releases are immutable"
  fi

  commit="$(resolve_release_commit "$tag")"
  trap remove_staging EXIT
  stage_release "$tag" "$commit"
  build_release
  write_release_env "$tag"
  run_migrations
  promote_release "$tag"
  activate_release "$tag"
  echo "Deployed $tag ($commit)"
}

rollback() {
  local tag="$1"
  validate_rollback_target "$tag"
  activate_release "$tag"
  echo "Rolled back to $tag; the database schema was not changed"
}

usage() {
  echo "Usage: deploy.sh vMAJOR.MINOR.PATCH" >&2
  echo "       deploy.sh --rollback vMAJOR.MINOR.PATCH" >&2
  exit 2
}

main() {
  local mode=deploy
  if [[ "${1:-}" == "--rollback" ]]; then
    mode=rollback
    shift
  fi
  if [[ "$#" -ne 1 ]]; then
    usage
  fi
  local tag="$1"

  validate_tag_format "$tag"
  require_root
  require_release_tree
  acquire_lock
  "$mode" "$tag"
}

main "$@"
