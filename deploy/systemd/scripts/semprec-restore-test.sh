#!/usr/bin/env bash
# Monthly restore test (issue #178): restores the newest restic snapshot into a work directory and
# a disposable PostgreSQL container on an internal Docker network, checks the restored database
# against the restored blob storage directories, and destroys everything it created. It never
# connects to the production containers or volumes.
set -euo pipefail

readonly RESTORE_ROOT=/var/tmp
readonly RESULT_CLI=/opt/semprec/current/backend/packages/data/dist/observability/restoreTestResultCli.js
readonly POSTGRES_IMAGE=postgres:16-alpine
readonly RESTORED_DUMP_PATH=var/backups/semprec/postgres.dump
readonly RESTORE_DATABASE=semprec_restore
readonly ITEMS_MAX_AGE_HOURS=48
readonly BLOB_SAMPLE_SIZE=20
readonly READY_ATTEMPTS=60

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
readonly RUN_ID
readonly RESOURCE_NAME="semprec-restore-test-$RUN_ID"
readonly NETWORK_NAME="$RESOURCE_NAME"
readonly POSTGRES_CONTAINER="$RESOURCE_NAME-postgres"

# The check that is running (or last ran); a failure is reported under this name.
CURRENT_CHECK=configuration
WORK_DIRECTORY=
NETWORK_CREATED=false
POSTGRES_CREATED=false
VERIFIED=false

require_environment() {
  local name
  for name in RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
    FILES_STORAGE_DIR MAIL_ATTACHMENTS_DIR SEMPREC_SIDE_DATABASE_URL \
    HEALTHCHECKS_RESTORE_PING_URL; do
    if [[ -z "${!name:-}" ]]; then
      echo "$name must be configured for the restore test" >&2
      exit 1
    fi
  done
}

# Removes every disposable resource this run created. Each step runs even when an earlier one
# fails, so one stuck resource cannot leave the others behind; the return status reports
# whether everything is gone.
destroy_disposable_state() {
  local status=0
  if [[ "$POSTGRES_CREATED" == true ]]; then
    if docker rm --force --volumes "$POSTGRES_CONTAINER" >/dev/null; then POSTGRES_CREATED=false; else status=1; fi
  fi
  if [[ "$NETWORK_CREATED" == true ]]; then
    if docker network rm "$NETWORK_NAME" >/dev/null; then NETWORK_CREATED=false; else status=1; fi
  fi
  if [[ -n "$WORK_DIRECTORY" ]]; then
    if rm -rf -- "$WORK_DIRECTORY"; then WORK_DIRECTORY=; else status=1; fi
  fi
  return "$status"
}

record_result() {
  DATABASE_URL="$SEMPREC_SIDE_DATABASE_URL" timeout 60 node "$RESULT_CLI" "$@"
}

# The monitor URL is an opaque secret: never print it or put it in an error message.
ping_monitor() {
  curl --fail --silent --show-error --output /dev/null --connect-timeout 10 --max-time 30 --proto '=https' \
    "$@"
}

report_failure() {
  local status=0
  echo "restore test $RUN_ID failed at check: $CURRENT_CHECK" >&2
  if [[ -z "${SEMPREC_SIDE_DATABASE_URL:-}" ]] || ! record_result failed "$RUN_ID" "$CURRENT_CHECK"; then
    echo "could not record the backup_restore_failed notification" >&2
    status=1
  fi
  if [[ -z "${HEALTHCHECKS_RESTORE_PING_URL:-}" ]] ||
    ! ping_monitor --data-raw "semprec-restore-test: $CURRENT_CHECK" "${HEALTHCHECKS_RESTORE_PING_URL%/}/fail"; then
    echo "could not send the external failure ping" >&2
    status=1
  fi
  return "$status"
}

on_exit() {
  local status=$?
  trap - EXIT
  set +e
  if ! destroy_disposable_state; then
    echo "could not remove all disposable restore-test state for $RESOURCE_NAME" >&2
    if [[ "$status" -eq 0 ]]; then
      status=1
    fi
  fi
  # A run that verified the restore but then failed to report success (the success ping or its
  # recording) is not a restore failure, so it gets no notification — only the non-zero exit.
  if [[ "$status" -ne 0 && "$VERIFIED" != true ]]; then
    report_failure
  fi
  exit "$status"
}

pg_query() {
  docker exec "$POSTGRES_CONTAINER" \
    psql --host=127.0.0.1 --username=postgres --dbname="$RESTORE_DATABASE" \
    --no-psqlrc --tuples-only --no-align --field-separator=$'\t' --set=ON_ERROR_STOP=1 --command="$1"
}

fail_check() {
  echo "$1" >&2
  exit 1
}

wait_until_ready() {
  local attempt
  for ((attempt = 1; attempt <= READY_ATTEMPTS; attempt++)); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

restore_snapshot() {
  CURRENT_CHECK=snapshotRestore
  WORK_DIRECTORY="$(mktemp -d "$RESTORE_ROOT/semprec-restore-test.XXXXXX")"
  restic restore latest --target "$WORK_DIRECTORY"
  [[ -s "$WORK_DIRECTORY/$RESTORED_DUMP_PATH" ]] || fail_check "restored snapshot has no PostgreSQL dump"
}

start_postgres() {
  CURRENT_CHECK=postgresStart
  docker network create --internal "$NETWORK_NAME" >/dev/null
  NETWORK_CREATED=true
  POSTGRES_CREATED=true
  docker run --detach --name "$POSTGRES_CONTAINER" --network "$NETWORK_NAME" \
    --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB="$RESTORE_DATABASE" \
    "$POSTGRES_IMAGE" postgres -c max_locks_per_transaction=2048 >/dev/null
  # TCP rather than the socket: the image's init-time server listens on the socket only and is
  # restarted before the real one accepts connections.
  wait_until_ready docker exec "$POSTGRES_CONTAINER" pg_isready --host=127.0.0.1 --username=postgres \
    --dbname="$RESTORE_DATABASE" || fail_check "disposable PostgreSQL did not become ready"
}

restore_postgres() {
  CURRENT_CHECK=pgRestore
  # Ownership and grants name production roles the disposable server does not have.
  docker exec --interactive "$POSTGRES_CONTAINER" \
    pg_restore --host=127.0.0.1 --username=postgres --dbname="$RESTORE_DATABASE" \
    --exit-on-error --no-owner --no-privileges < "$WORK_DIRECTORY/$RESTORED_DUMP_PATH"
}

check_postgres_contents() {
  CURRENT_CHECK=itemsCount
  local items_count
  items_count="$(pg_query 'SELECT count(*) FROM items')"
  [[ "$items_count" =~ ^[0-9]+$ && "$items_count" -gt 0 ]] || fail_check "restored items table is empty"

  CURRENT_CHECK=itemsFreshness
  local items_fresh
  items_fresh="$(pg_query "SELECT coalesce(max(updated_at) >= now() - interval '$ITEMS_MAX_AGE_HOURS hours', false) FROM items")"
  [[ "$items_fresh" == t ]] || fail_check "newest restored item is older than $ITEMS_MAX_AGE_HOURS hours"

  CURRENT_CHECK=docSnapshotsCount
  local snapshots_count
  snapshots_count="$(pg_query 'SELECT count(*) FROM doc_snapshots')"
  [[ "$snapshots_count" =~ ^[0-9]+$ && "$snapshots_count" -gt 0 ]] || fail_check "restored doc_snapshots table is empty"

  CURRENT_CHECK=docSnapshotsState
  local empty_snapshots
  empty_snapshots="$(pg_query 'SELECT count(*) FROM doc_snapshots WHERE octet_length(state) = 0')"
  [[ "$empty_snapshots" == 0 ]] || fail_check "restored doc_snapshots has empty state"
}

# restic restores absolute paths under the work directory. A `blobs.storage_key` is relative to
# whichever of the two storage directories its writer was given, so each sampled key is looked up
# in the files directory first and in the mail-attachments directory second.
restored_blob_file() {
  local directory
  for directory in "$FILES_STORAGE_DIR" "$MAIL_ATTACHMENTS_DIR"; do
    if [[ -f "$WORK_DIRECTORY$directory/$1" ]]; then
      printf '%s\n' "$WORK_DIRECTORY$directory/$1"
      return 0
    fi
  done
  return 1
}

# Each sampled file must have exactly the size and SHA-256 content hash the restored `blobs` row
# records for it — the two halves of the snapshot have to agree with each other.
check_blob_objects() {
  CURRENT_CHECK=blobObjects
  local samples
  samples="$(pg_query "SELECT storage_key, content_hash, byte_size FROM blobs
    WHERE content_hash IS NOT NULL ORDER BY random() LIMIT $BLOB_SAMPLE_SIZE")"
  if [[ -z "$samples" ]]; then
    echo "restored blobs table has no hashed objects to compare"
    return 0
  fi

  local storage_key content_hash byte_size actual_hash actual_size blob_file checked=0
  while IFS=$'\t' read -r storage_key content_hash byte_size; do
    blob_file="$(restored_blob_file "$storage_key")" ||
      fail_check "restored snapshot has no file for a sampled blob"
    actual_size="$(stat --format '%s' "$blob_file")"
    actual_hash="$(sha256sum "$blob_file" | cut -d' ' -f1)"
    [[ "$actual_size" == "$byte_size" && "$actual_hash" == "$content_hash" ]] ||
      fail_check "restored blob file does not match its blobs row"
    checked=$((checked + 1))
  done <<< "$samples"
  echo "compared $checked restored blob files"
}

main() {
  trap on_exit EXIT
  # systemd stops a timed-out run with SIGTERM; exiting through the EXIT trap still cleans up.
  trap 'exit 143' TERM INT
  require_environment

  restore_snapshot
  start_postgres
  restore_postgres
  check_postgres_contents
  check_blob_objects

  CURRENT_CHECK=cleanup
  destroy_disposable_state
  VERIFIED=true

  record_result passed "$RUN_ID"
  ping_monitor "$HEALTHCHECKS_RESTORE_PING_URL"
  echo "restore test $RUN_ID passed"
}

main "$@"
