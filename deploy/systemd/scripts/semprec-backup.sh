#!/usr/bin/env bash
set -euo pipefail

readonly COMPOSE_FILE=/opt/semprec/current/deploy/docker-compose.yml
readonly BACKUP_DIRECTORY=/var/backups/semprec
readonly DUMP_FILE="$BACKUP_DIRECTORY/postgres.dump"
readonly DUMP_TEMPORARY_FILE="$DUMP_FILE.tmp"

require_environment() {
  local name
  for name in POSTGRES_USER POSTGRES_DB RESTIC_REPOSITORY RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
    if [[ -z "${!name:-}" ]]; then
      echo "$name must be configured for the backup" >&2
      exit 1
    fi
  done
}

remove_partial_dump() {
  rm -f -- "$DUMP_TEMPORARY_FILE"
}

minio_data_directory() {
  local container_id
  container_id="$(docker compose -f "$COMPOSE_FILE" ps -q minio)"
  if [[ -z "$container_id" ]]; then
    echo "MinIO container is not running" >&2
    exit 1
  fi

  local data_directory
  data_directory="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$container_id")"
  if [[ -z "$data_directory" ]]; then
    echo "Cannot determine the MinIO data volume" >&2
    exit 1
  fi

  printf '%s\n' "$data_directory"
}

main() {
  require_environment
  install -d -o root -g root -m 0700 "$BACKUP_DIRECTORY"
  trap remove_partial_dump EXIT

  # Writing to a temporary file prevents restic from ever receiving a partial custom dump.
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom > "$DUMP_TEMPORARY_FILE"
  mv -- "$DUMP_TEMPORARY_FILE" "$DUMP_FILE"

  local minio_data
  minio_data="$(minio_data_directory)"
  restic backup "$DUMP_FILE" "$minio_data"
  restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
}

main "$@"
