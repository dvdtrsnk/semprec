#!/usr/bin/env bash
# Hermetic behavior test for the monthly restore-test script.
set -euo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly REPOSITORY_ROOT
TEST_ROOT="$(mktemp -d)"
readonly TEST_ROOT
readonly TEST_BIN="$TEST_ROOT/bin"
readonly TEST_STATE="$TEST_ROOT/state"
readonly TEST_RESTORE_ROOT="$TEST_ROOT/var/tmp"
readonly TEST_BLOBS="$TEST_ROOT/blobs"
readonly TEST_SCRIPT="$TEST_ROOT/semprec-restore-test.sh"
readonly PING_URL=https://hc.example.invalid/ping/restore-check
export TEST_STATE TEST_BLOBS

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$TEST_BIN" "$TEST_STATE" "$TEST_RESTORE_ROOT" "$TEST_BLOBS"
cp "$REPOSITORY_ROOT/deploy/systemd/scripts/semprec-restore-test.sh" "$TEST_SCRIPT"
sed -i "s|readonly RESTORE_ROOT=/var/tmp|readonly RESTORE_ROOT=$TEST_RESTORE_ROOT|" "$TEST_SCRIPT"

# Three blob objects in the "restored" MinIO; the restored blobs table records their hashes.
for key in files/a files/b mail/c; do
  mkdir -p "$TEST_BLOBS/$(dirname "$key")"
  printf 'object %s' "$key" > "$TEST_BLOBS/$key"
  printf '%s\t%s\t%s\n' "$key" "$(sha256sum "$TEST_BLOBS/$key" | cut -d' ' -f1)" "$(stat --format '%s' "$TEST_BLOBS/$key")"
done > "$TEST_STATE/blob-rows"

write_mock() {
  local name="$1"
  local body="$2"
  printf '#!/usr/bin/env bash\nset -euo pipefail\n%s\n' "$body" > "$TEST_BIN/$name"
  chmod +x "$TEST_BIN/$name"
}

# Disposable containers and networks exist as files under $TEST_STATE/resources until removed.
write_mock docker '
printf "docker %s\\n" "$*" >> "$TEST_STATE/commands"
fail() { [[ -e "$TEST_STATE/fail-$1" ]]; }
mkdir -p "$TEST_STATE/resources"
case "$1" in
  network)
    if [[ "$2" == create ]]; then touch "$TEST_STATE/resources/network-${!#}"; fi
    if [[ "$2" == rm ]]; then rm "$TEST_STATE/resources/network-$3"; fi ;;
  rm)
    if fail docker-rm-once; then rm "$TEST_STATE/fail-docker-rm-once"; exit 31; fi
    rm "$TEST_STATE/resources/container-${!#}" ;;
  run)
    if [[ "$2" == --detach ]]; then touch "$TEST_STATE/resources/container-$4"; exit 0; fi
    object="${!#}"
    object="${object#restore/restore-bucket/}"
    if fail blob-read; then exit 32; fi
    cat "$TEST_BLOBS/$object"
    if fail blob-mismatch; then printf "corrupted"; fi ;;
  exec)
    arguments=" $* "
    if [[ "$arguments" == *" pg_isready "* ]]; then ! fail postgres-ready
    elif [[ "$arguments" == *" mc ready local "* ]]; then ! fail minio-ready
    elif [[ "$arguments" == *" pg_restore "* ]]; then cat > /dev/null; ! fail pg-restore
    elif [[ "$arguments" == *"FROM blobs"* ]]; then cat "$TEST_STATE/blob-rows"
    elif [[ "$arguments" == *"octet_length(state) = 0"* ]]; then if fail empty-doc-state; then echo 1; else echo 0; fi
    elif [[ "$arguments" == *"FROM doc_snapshots"* ]]; then if fail no-doc-snapshots; then echo 0; else echo 4; fi
    elif [[ "$arguments" == *"max(updated_at)"* ]]; then if fail stale-items; then echo f; else echo t; fi
    elif [[ "$arguments" == *"count(*) FROM items"* ]]; then if fail no-items; then echo 0; else echo 12; fi
    else exit 33
    fi ;;
  *) exit 34 ;;
esac'
write_mock restic '
printf "restic %s\\n" "$*" >> "$TEST_STATE/commands"
if [[ -e "$TEST_STATE/fail-restic-restore" ]]; then exit 35; fi
target="${!#}"
mkdir -p "$target/var/backups/semprec" "$target/var/lib/docker/volumes/deploy_minio_data/_data/.minio.sys"
printf "custom PostgreSQL dump" > "$target/var/backups/semprec/postgres.dump"'
write_mock curl 'printf "%s\\n" "${!#}" >> "$TEST_STATE/pings"'
write_mock node '
shift
printf "%s DATABASE_URL=%s\\n" "$*" "$DATABASE_URL" >> "$TEST_STATE/results"'
write_mock timeout 'shift; exec "$@"'
write_mock sleep ':'

run_restore_test() {
  PATH="$TEST_BIN:$PATH" \
    RESTIC_REPOSITORY=s3:https://backup.example.invalid/semprec \
    RESTIC_PASSWORD=test-only-password \
    AWS_ACCESS_KEY_ID=test-access-key \
    AWS_SECRET_ACCESS_KEY=test-secret-key \
    MINIO_ROOT_USER=minio-user \
    MINIO_ROOT_PASSWORD='p@ss word/ü' \
    MINIO_BLOB_BUCKET=restore-bucket \
    SEMPREC_SIDE_DATABASE_URL=postgres://semprec_side@127.0.0.1:5432/semprec \
    HEALTHCHECKS_RESTORE_PING_URL="$PING_URL" \
    "$@" bash "$TEST_SCRIPT"
}

reset_state() {
  rm -rf "$TEST_STATE/commands" "$TEST_STATE/pings" "$TEST_STATE/results" "$TEST_STATE/resources" "$TEST_STATE"/fail-*
}

count_lines() {
  local pattern="$1"
  local file="$2"
  if [[ -e "$file" ]]; then grep -c -- "$pattern" "$file" || true; else echo 0; fi
}

assert_disposable_state_removed() {
  if [[ -n "$(ls -A "$TEST_STATE/resources" 2>/dev/null)" ]]; then
    echo "disposable resources left behind: $(ls "$TEST_STATE/resources")" >&2
    exit 1
  fi
  if [[ -n "$(ls -A "$TEST_RESTORE_ROOT")" ]]; then
    echo "restore work directory left behind" >&2
    exit 1
  fi
}

assert_never_touches_production() {
  if grep -q -e 'compose' -e 'postgres_data' "$TEST_STATE/commands"; then
    echo "the restore test addressed a production container or volume" >&2
    exit 1
  fi
  if grep '^docker run ' "$TEST_STATE/commands" | grep -v -q -- '--network semprec-restore-test-'; then
    echo "a disposable container ran outside the restore-test network" >&2
    exit 1
  fi
  if grep '^docker network create ' "$TEST_STATE/commands" | grep -v -q -- '--internal'; then
    echo "the restore-test network is not internal" >&2
    exit 1
  fi
}

# A valid fixture passes, records the pass, and pings the success URL exactly once.
reset_state
run_restore_test env
test "$(count_lines . "$TEST_STATE/pings")" -eq 1
grep -qx "$PING_URL" "$TEST_STATE/pings"
test "$(count_lines . "$TEST_STATE/results")" -eq 1
grep -Eq '^passed [0-9]{8}T[0-9]{6}Z-[0-9]+ DATABASE_URL=postgres://semprec_side@' "$TEST_STATE/results"
test "$(count_lines '^docker run --rm ' "$TEST_STATE/commands")" -eq 3
grep -q -- '--exit-on-error' "$TEST_STATE/commands"
if grep -q -e 'p@ss' -e 'minio-user' -e 'test-only-password' "$TEST_STATE/commands"; then
  echo "a secret appeared on a command line" >&2
  exit 1
fi
assert_never_touches_production
assert_disposable_state_removed

# Each injected failure records exactly one failure for its check, pings /fail exactly once,
# never pings success, exits non-zero, and leaves no disposable state behind.
assert_failure() {
  local expected_check="$1"
  shift
  reset_state
  local flag
  for flag in "$@"; do
    touch "$TEST_STATE/fail-$flag"
  done
  if run_restore_test env; then
    echo "$expected_check failure unexpectedly succeeded" >&2
    exit 1
  fi
  test "$(count_lines . "$TEST_STATE/results")" -eq 1
  grep -Eq "^failed [0-9]{8}T[0-9]{6}Z-[0-9]+ $expected_check DATABASE_URL=" "$TEST_STATE/results"
  test "$(count_lines . "$TEST_STATE/pings")" -eq 1
  grep -qx "$PING_URL/fail" "$TEST_STATE/pings"
  assert_disposable_state_removed
}

assert_failure snapshotRestore restic-restore
assert_failure postgresStart postgres-ready
assert_failure pgRestore pg-restore
assert_failure itemsCount no-items
assert_failure itemsFreshness stale-items
assert_failure docSnapshotsCount no-doc-snapshots
assert_failure docSnapshotsState empty-doc-state
assert_failure minioStart minio-ready
assert_failure blobObjects blob-read
assert_failure blobObjects blob-mismatch
# The first container removal fails; the exit path retries it, so nothing is left behind.
assert_failure cleanup docker-rm-once

# Missing configuration is itself a failed run.
reset_state
if run_restore_test env -u MINIO_BLOB_BUCKET; then
  echo "missing configuration unexpectedly succeeded" >&2
  exit 1
fi
grep -Eq '^failed [^ ]+ configuration ' "$TEST_STATE/results"
grep -qx "$PING_URL/fail" "$TEST_STATE/pings"
if test -e "$TEST_STATE/commands"; then
  echo "missing configuration still ran a restore" >&2
  exit 1
fi

echo 'semprec-restore-test.sh behavior test passed'
