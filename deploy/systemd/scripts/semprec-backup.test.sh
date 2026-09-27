#!/usr/bin/env bash
# Hermetic behavior test for the daily PostgreSQL and blob storage backup script.
set -euo pipefail

readonly REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly TEST_ROOT="$(mktemp -d)"
readonly TEST_BIN="$TEST_ROOT/bin"
readonly TEST_STATE="$TEST_ROOT/state"
readonly TEST_BACKUP_DIRECTORY="$TEST_ROOT/var/backups/semprec"
readonly TEST_FILES_DIRECTORY="$TEST_ROOT/data/files"
readonly TEST_MAIL_ATTACHMENTS_DIRECTORY="$TEST_ROOT/data/mail-attachments"
readonly TEST_SCRIPT="$TEST_ROOT/semprec-backup.sh"
export TEST_STATE

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$TEST_BIN" "$TEST_STATE" "$TEST_FILES_DIRECTORY" "$TEST_MAIL_ATTACHMENTS_DIRECTORY"
cp "$REPOSITORY_ROOT/deploy/systemd/scripts/semprec-backup.sh" "$TEST_SCRIPT"
sed -i "s|readonly BACKUP_DIRECTORY=/var/backups/semprec|readonly BACKUP_DIRECTORY=$TEST_BACKUP_DIRECTORY|" "$TEST_SCRIPT"

write_mock() {
  local name="$1"
  local body="$2"
  printf '#!/usr/bin/env bash\nset -euo pipefail\n%s\n' "$body" > "$TEST_BIN/$name"
  chmod +x "$TEST_BIN/$name"
}

write_mock docker '
printf "docker %s\\n" "$*" >> "$TEST_STATE/commands"
if [[ "$1" == "compose" && " $* " == *" exec -T postgres "* ]]; then
  if [[ -e "$TEST_STATE/fail-pg-dump" ]]; then exit 23; fi
  printf "custom PostgreSQL dump"
else
  exit 24
fi'
write_mock install 'mkdir -p "${!#}"'
write_mock restic '
printf "restic %s\\n" "$*" >> "$TEST_STATE/commands"
if [[ "$1" == "backup" && -e "$TEST_STATE/fail-restic-backup" ]]; then exit 25; fi
if [[ "$1" == "forget" && -e "$TEST_STATE/fail-restic-forget" ]]; then exit 26; fi'

run_backup() {
  PATH="$TEST_BIN:$PATH" \
    POSTGRES_USER=postgres \
    POSTGRES_DB=semprec \
    RESTIC_REPOSITORY=s3:https://backup.example.invalid/semprec \
    RESTIC_PASSWORD=test-only-password \
    AWS_ACCESS_KEY_ID=test-access-key \
    AWS_SECRET_ACCESS_KEY=test-secret-key \
    FILES_STORAGE_DIR="$TEST_FILES_DIRECTORY" \
    MAIL_ATTACHMENTS_DIR="$TEST_MAIL_ATTACHMENTS_DIRECTORY" \
    "$@" bash "$TEST_SCRIPT"
}

run_backup env
test -f "$TEST_BACKUP_DIRECTORY/postgres.dump"
grep -qx 'custom PostgreSQL dump' "$TEST_BACKUP_DIRECTORY/postgres.dump"
grep -qx "restic backup $TEST_BACKUP_DIRECTORY/postgres.dump $TEST_FILES_DIRECTORY $TEST_MAIL_ATTACHMENTS_DIRECTORY" "$TEST_STATE/commands"
if grep -q -i -e '^docker inspect ' -e 'minio' "$TEST_STATE/commands"; then
  echo 'the backup still addressed MinIO' >&2
  exit 1
fi
grep -qx 'restic forget --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune' "$TEST_STATE/commands"
test "$(grep -n '^restic backup ' "$TEST_STATE/commands" | cut -d: -f1)" -lt "$(grep -n '^restic forget ' "$TEST_STATE/commands" | cut -d: -f1)"
! rg -q '/opt/semprec/shared|/var/log/journal|/etc/caddy|/opt/semprec/releases|CREDENTIALS_MASTER_KEY|SECRETS_MASTER_KEY' "$TEST_STATE/commands"

rm -f "$TEST_STATE/commands"
touch "$TEST_STATE/fail-pg-dump"
if run_backup env; then
  echo 'pg_dump failure unexpectedly succeeded' >&2
  exit 1
fi
! test -e "$TEST_BACKUP_DIRECTORY/postgres.dump.tmp"
! test -e "$TEST_STATE/commands" || ! grep -q '^restic ' "$TEST_STATE/commands"
rm "$TEST_STATE/fail-pg-dump" "$TEST_STATE/commands"

touch "$TEST_STATE/fail-restic-backup"
if run_backup env; then
  echo 'restic backup failure unexpectedly succeeded' >&2
  exit 1
fi
! grep -q '^restic forget ' "$TEST_STATE/commands"
rm "$TEST_STATE/fail-restic-backup" "$TEST_STATE/commands"

touch "$TEST_STATE/fail-restic-forget"
if run_backup env; then
  echo 'restic retention failure unexpectedly succeeded' >&2
  exit 1
fi
rm "$TEST_STATE/fail-restic-forget" "$TEST_STATE/commands"

# A storage variable that is unset, or names a directory that does not exist, fails the backup
# before any restic call and names the variable.
assert_storage_configuration_failure() {
  local name="$1"
  shift
  rm -f "$TEST_STATE/commands"
  if run_backup "$@" 2> "$TEST_STATE/stderr"; then
    echo "backup without $name unexpectedly succeeded" >&2
    exit 1
  fi
  grep -q "$name" "$TEST_STATE/stderr"
  if test -e "$TEST_STATE/commands" && grep -q '^restic ' "$TEST_STATE/commands"; then
    echo "backup without $name still called restic" >&2
    exit 1
  fi
}

assert_storage_configuration_failure FILES_STORAGE_DIR env -u FILES_STORAGE_DIR
assert_storage_configuration_failure MAIL_ATTACHMENTS_DIR env -u MAIL_ATTACHMENTS_DIR
assert_storage_configuration_failure FILES_STORAGE_DIR env FILES_STORAGE_DIR="$TEST_ROOT/data/missing-files"
assert_storage_configuration_failure MAIL_ATTACHMENTS_DIR env MAIL_ATTACHMENTS_DIR="$TEST_ROOT/data/missing-mail"

echo 'semprec-backup.sh behavior test passed'
