#!/usr/bin/env bash
# Deploy one release tag as an immutable release behind the atomic `current` symlink (issue #190).
#
# Usage: deploy.sh vMAJOR.MINOR.PATCH
#
# Run as root from an operator checkout of the repository whose `origin` holds the release tags.
# Everything up to the symlink swap happens in a hidden staging directory; any failure there
# removes it and leaves `current` and the running services untouched.
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
    systemctl restart "$unit" || fail "$unit failed to restart after current moved to the new release"
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

main() {
  if [[ "$#" -ne 1 ]]; then
    echo "Usage: deploy.sh vMAJOR.MINOR.PATCH" >&2
    exit 2
  fi
  local tag="$1"
  local commit

  validate_tag_format "$tag"
  require_root
  require_release_tree
  acquire_lock
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
  echo "Deployed $tag ($commit)"
}

main "$@"
