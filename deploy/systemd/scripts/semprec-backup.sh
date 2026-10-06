#!/usr/bin/env bash
# Daily off-site backup: a PostgreSQL custom dump plus the two blob storage directories the
# `blobs` rows point into (FILES_STORAGE_DIR and MAIL_ATTACHMENTS_DIR), snapshotted together by
# restic so the rows and their bytes always come from the same run. The per-tenant wrapped data
# keys (`tenant_keys`) are excluded from that long-retention dump and snapshotted separately with
# 7-day retention, so deleting a tenant's key row removes the key from the repository within a week.
set -euo pipefail

readonly COMPOSE_FILE=/opt/semprec/current/deploy/docker-compose.yml
readonly BACKUP_DIRECTORY=/var/backups/semprec
readonly DUMP_FILE="$BACKUP_DIRECTORY/postgres.dump"
readonly DUMP_TEMPORARY_FILE="$DUMP_FILE.tmp"
readonly TENANT_KEYS_DUMP_FILE="$BACKUP_DIRECTORY/tenant-keys.dump"
readonly TENANT_KEYS_DUMP_TEMPORARY_FILE="$TENANT_KEYS_DUMP_FILE.tmp"

require_environment() {
  local name
  for name in POSTGRES_USER POSTGRES_DB RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
    FILES_STORAGE_DIR MAIL_ATTACHMENTS_DIR; do
    if [[ -z "${!name:-}" ]]; then
      echo "$name must be configured for the backup" >&2
      exit 1
    fi
  done
}

remove_partial_dump() {
  rm -f -- "$DUMP_TEMPORARY_FILE" "$TENANT_KEYS_DUMP_TEMPORARY_FILE"
}

# Both blob directories are created at provisioning; a missing one means the configuration points
# somewhere wrong, and backing up without it would silently drop every blob it should hold.
require_storage_directories() {
  local name
  for name in FILES_STORAGE_DIR MAIL_ATTACHMENTS_DIR; do
    if [[ ! -d "${!name}" ]]; then
      echo "$name directory ${!name} does not exist" >&2
      exit 1
    fi
  done
}

main() {
  require_environment
  require_storage_directories
  install -d -o root -g root -m 0700 "$BACKUP_DIRECTORY"
  trap remove_partial_dump EXIT

  # Writing to a temporary file prevents restic from ever receiving a partial custom dump.
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom \
    --exclude-table-data=public.tenant_keys > "$DUMP_TEMPORARY_FILE"
  mv -- "$DUMP_TEMPORARY_FILE" "$DUMP_FILE"

  # Taken after the main dump: keys are only ever created or deleted, so every credential in the
  # main dump has its key in this one.
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --data-only \
    --table=public.tenant_keys > "$TENANT_KEYS_DUMP_TEMPORARY_FILE"
  mv -- "$TENANT_KEYS_DUMP_TEMPORARY_FILE" "$TENANT_KEYS_DUMP_FILE"

  restic backup "$DUMP_FILE" "$FILES_STORAGE_DIR" "$MAIL_ATTACHMENTS_DIR"
  restic backup "$TENANT_KEYS_DUMP_FILE"

  # Retention runs only after both snapshots exist; --path keeps each policy to its own kind.
  restic forget --path "$DUMP_FILE" --keep-daily 14 --keep-weekly 8 --keep-monthly 12
  restic forget --path "$TENANT_KEYS_DUMP_FILE" --keep-within 7d
  restic prune
}

main "$@"
