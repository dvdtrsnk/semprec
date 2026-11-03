#!/usr/bin/env bash
# Monthly restore test (issue #178): restores the newest restic snapshot into a work directory and
# a disposable PostgreSQL container on a dedicated authenticated loopback bridge, checks the restored database
# against the restored blob storage directories, and destroys everything it created. It never
# connects to the production containers or volumes.
set -euo pipefail

readonly RESTORE_ROOT=/var/tmp
readonly RESULT_CLI=/opt/semprec/current/backend/packages/data/dist/observability/restoreTestResultCli.js
readonly KEY_RESTORE_CLI=/opt/semprec/current/backend/packages/data/dist/tenancy/restoreTenantKeysCli.js
readonly LEDGER_VALIDATOR=/opt/semprec/current/backend/packages/data/dist/tenancy/validateRestoreLedgerCli.js
readonly POSTGRES_IMAGE=postgres:16-alpine
readonly RESTORED_DUMP_PATH=var/backups/semprec/postgres.dump
readonly RESTORED_DELETION_LEDGER_PATH=var/backups/semprec/tenant-deletions.ledger
readonly RESTORED_TENANT_KEYS_DUMP_PATH=var/backups/semprec/tenant-keys.dump
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
NETWORK_ATTEMPTED=false
POSTGRES_ATTEMPTED=false
NETWORK_ID=
VERIFIED=false
POSTGRES_ID=
RESTORE_DATABASE_URL=
OWNER_RUNNING=false
PRESERVE_STATE=false

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

# Removes positively identified resources after their dependent work settles. An uncertain
# creation or failed cleanup preserves the remaining state for reconciliation.
destroy_disposable_state() {
  local exec_ids ids identity uncertain=false
  if [[ "$OWNER_RUNNING" == true || "$PRESERVE_STATE" == true ]]; then return 1; fi
  if [[ "$POSTGRES_ATTEMPTED" == true && -z "$POSTGRES_ID" ]]; then uncertain=true; fi
  if [[ "$NETWORK_ATTEMPTED" == true && -z "$NETWORK_ID" ]]; then uncertain=true; fi
  if [[ -n "$POSTGRES_ID" ]]; then
    ids="$(docker ps --all --no-trunc --format '{{.ID}}')" || return 1
    if grep -Fxq -- "$POSTGRES_ID" <<< "$ids"; then
      identity="$(docker container inspect --format '{{.Id}}' "$POSTGRES_ID")" || return 1
      [[ "$identity" == "$POSTGRES_ID" ]] || return 1
      exec_ids="$(docker container inspect --format '{{json .ExecIDs}}' "$POSTGRES_ID")" || return 1
      [[ "$exec_ids" == null || "$exec_ids" == '[]' ]] || return 1
      docker rm --force --volumes "$POSTGRES_ID" >/dev/null || return 1
      ids="$(docker ps --all --no-trunc --format '{{.ID}}')" || return 1
      ! grep -Fxq -- "$POSTGRES_ID" <<< "$ids" || return 1
    fi
    POSTGRES_ID=
    POSTGRES_ATTEMPTED=false
  fi
  # An unknown container may still be attached to the owned network.
  if [[ "$uncertain" == true ]]; then return 1; fi
  if [[ -n "$NETWORK_ID" ]]; then
    ids="$(docker network ls --no-trunc --format '{{.ID}}')" || return 1
    if grep -Fxq -- "$NETWORK_ID" <<< "$ids"; then
      identity="$(docker network inspect --format '{{.Id}}' "$NETWORK_ID")" || return 1
      [[ "$identity" == "$NETWORK_ID" ]] || return 1
      docker network rm "$NETWORK_ID" >/dev/null || return 1
      ids="$(docker network ls --no-trunc --format '{{.ID}}')" || return 1
      ! grep -Fxq -- "$NETWORK_ID" <<< "$ids" || return 1
    fi
    NETWORK_ID=
    NETWORK_ATTEMPTED=false
  fi
  if [[ -n "$WORK_DIRECTORY" ]]; then
    rm -rf -- "$WORK_DIRECTORY" || return 1
    WORK_DIRECTORY=
  fi
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
  docker exec "$POSTGRES_ID" \
    psql --username=postgres --dbname="$RESTORE_DATABASE" \
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
  # Main and key snapshots interleave; a bare `latest` would pick whichever kind ran last.
  restic restore latest --path "/$RESTORED_DUMP_PATH" --target "$WORK_DIRECTORY"
  [[ -s "$WORK_DIRECTORY/$RESTORED_DUMP_PATH" ]] || fail_check "restored snapshot has no PostgreSQL dump"
}

start_postgres() {
  CURRENT_CHECK=postgresStart
  local names password env_file mapping port candidate identity
  names="$(docker ps --all --filter "name=^/$POSTGRES_CONTAINER$" --format '{{.Names}}')" || fail_check "container lookup failed"
  [[ -z "$names" ]] || fail_check "restore container identity already exists"
  names="$(docker network ls --filter "name=^${NETWORK_NAME}$" --format '{{.Name}}')" || fail_check "network lookup failed"
  [[ -z "$names" ]] || fail_check "restore network identity already exists"
  NETWORK_ATTEMPTED=true
  candidate="$(docker network create --driver bridge --opt com.docker.network.bridge.enable_ip_masquerade=false "$NETWORK_NAME")"
  [[ "$candidate" =~ ^[a-f0-9]{64}$ ]] || fail_check "invalid restore network identity"
  identity="$(docker network inspect --format '{{.Id}}' "$candidate")" || fail_check "restore network identity unavailable"
  [[ "$identity" == "$candidate" ]] || fail_check "restore network identity mismatch"
  NETWORK_ID="$candidate"
  password="$(openssl rand -hex 32)"
  [[ "$password" =~ ^[a-f0-9]{64}$ ]] || fail_check "could not generate restore password"
  env_file="$WORK_DIRECTORY/postgres.env"
  ( umask 077; printf 'POSTGRES_PASSWORD=%s\nPOSTGRES_DB=%s\n' "$password" "$RESTORE_DATABASE" > "$env_file" )
  POSTGRES_ATTEMPTED=true
  candidate="$(docker run --detach --name "$POSTGRES_CONTAINER" --network "$NETWORK_ID" \
    --publish 127.0.0.1::5432 --env-file "$env_file" \
    "$POSTGRES_IMAGE" postgres -c max_locks_per_transaction=2048)"
  [[ "$candidate" =~ ^[a-f0-9]{64}$ ]] || fail_check "invalid restore container identity"
  identity="$(docker container inspect --format '{{.Id}}' "$candidate")" || fail_check "restore container identity unavailable"
  [[ "$identity" == "$candidate" ]] || fail_check "restore container identity mismatch"
  POSTGRES_ID="$candidate"
  wait_until_ready docker exec "$POSTGRES_ID" pg_isready --host=127.0.0.1 --username=postgres \
    --dbname="$RESTORE_DATABASE" || fail_check "disposable PostgreSQL did not become ready"
  mapping="$(docker port "$POSTGRES_ID" 5432/tcp)" || fail_check "restore port mapping is unavailable"
  [[ "$mapping" =~ ^127\.0\.0\.1:([0-9]{1,5})$ ]] || fail_check "restore port mapping is not loopback"
  port="${BASH_REMATCH[1]}"
  (( 10#$port > 0 && 10#$port <= 65535 )) || fail_check "restore port is invalid"
  RESTORE_DATABASE_URL="postgresql://postgres:${password}@127.0.0.1:${port}/${RESTORE_DATABASE}"
}

restore_postgres() {
  CURRENT_CHECK=pgRestore
  # Ownership and grants name production roles the disposable server does not have.
  docker exec --interactive "$POSTGRES_ID" \
    pg_restore --username=postgres --dbname="$RESTORE_DATABASE" \
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

# The later ledger must cover the snapshot tombstones; extra newer IDs remain replay evidence.
check_deletion_ledger() {
  CURRENT_CHECK=deletionLedger
  local ledger="$WORK_DIRECTORY/$RESTORED_DELETION_LEDGER_PATH"
  [[ -f "$ledger" ]] || fail_check "restored snapshot has no tenant deletion ledger"
  OWNER_RUNNING=true
  if DATABASE_URL="$RESTORE_DATABASE_URL" SEMPREC_RESTORE_TARGET_ROLE=semprec_restore \
      node "$LEDGER_VALIDATOR" --database "$ledger"; then
    OWNER_RUNNING=false
  else
    local owner_status=$?
    OWNER_RUNNING=false
    (( owner_status < 128 )) || PRESERVE_STATE=true
    fail_check "restore ledger validation failed"
  fi
}

# Every backup writes the key dump after the main dump, and the main dump holds no tenant_keys data.
check_tenant_keys_excluded() {
  CURRENT_CHECK=tenantKeysExcluded
  local key_rows
  key_rows="$(pg_query 'SELECT count(*) FROM tenant_keys')"
  [[ "$key_rows" == 0 ]] || fail_check "restored main dump contains tenant_keys rows"
}

# Restore the independently retained keys through the scoped offline owner.
check_tenant_keys_restore() {
  CURRENT_CHECK=tenantKeysRestore
  restic restore latest --path "/$RESTORED_TENANT_KEYS_DUMP_PATH" --target "$WORK_DIRECTORY"
  [[ -s "$WORK_DIRECTORY/$RESTORED_TENANT_KEYS_DUMP_PATH" ]] || fail_check "restored key snapshot has no tenant keys dump"
  OWNER_RUNNING=true
  if SEMPREC_RESTORE_ADMIN_URL="$RESTORE_DATABASE_URL" SEMPREC_RESTORE_TARGET_URL="$RESTORE_DATABASE_URL" \
      SEMPREC_RESTORE_CONTAINER="$POSTGRES_ID" SEMPREC_RESTORE_TARGET_ROLE=semprec_restore \
      SEMPREC_RESTORE_RECEIPT="$WORK_DIRECTORY/key-restore.receipt" \
      node "$KEY_RESTORE_CLI" "$WORK_DIRECTORY/$RESTORED_TENANT_KEYS_DUMP_PATH"; then
    OWNER_RUNNING=false
  else
    local owner_status=$?
    OWNER_RUNNING=false
    if (( owner_status >= 128 )) || [[ -s "$WORK_DIRECTORY/key-restore.receipt" ]]; then PRESERVE_STATE=true; fi
    fail_check "offline tenant key restore failed"
  fi
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
  pg_query "CREATE ROLE semprec_restore NOLOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO semprec_restore;
    GRANT SELECT ON public.tenants, public.tenant_deletions TO semprec_restore;
    GRANT SELECT, INSERT ON public.tenant_keys TO semprec_restore;
    GRANT EXECUTE ON FUNCTION public.app_tenant_default() TO semprec_restore" >/dev/null
  check_postgres_contents
  check_deletion_ledger
  check_tenant_keys_excluded
  check_tenant_keys_restore
  check_blob_objects

  CURRENT_CHECK=cleanup
  destroy_disposable_state
  VERIFIED=true

  record_result passed "$RUN_ID"
  ping_monitor "$HEALTHCHECKS_RESTORE_PING_URL"
  echo "restore test $RUN_ID passed"
}

main "$@"
