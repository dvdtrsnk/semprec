#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$WORK/bin"
export TEST_ACTIVATION_WORK="$WORK"
export TEST_ACTIVATION_NODE="${TEST_ACTIVATION_NODE:-$(command -v node)}"

# Execute the documentation's marked block itself, once and without changing its commands.
awk '
  /<!-- restore-activation-command:start -->/ { if (found++) exit 1; state = 1; next }
  /<!-- restore-activation-command:end -->/ { if (state != 2) exit 1; state = 3; next }
  state == 1 && /^```bash$/ { state = 2; next }
  state == 2 && /^```$/ { next }
  state == 2 { print }
  END { if (found != 1 || state != 3) exit 1 }
' "$ROOT/deploy/README.md" > "$WORK/activation.sh"

cat > "$WORK/bin/restic" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ ! -e "$TEST_ACTIVATION_WORK/fail-fetch" ]] || exit 31
printf '%s\n' "${TEST_ACTIVATION_LEDGER_ID:-11111111-1111-4111-8111-111111111111}"
MOCK
cat > "$WORK/bin/node" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ -e "$TEST_ACTIVATION_WORK/fail-missing-entry" && "$1" == */replayTenantDeletionsCli.js ]]; then
  exec "$TEST_ACTIVATION_NODE" "$TEST_ACTIVATION_WORK/missing-entry.js"
fi
if [[ -n "${TEST_ACTIVATION_NATIVE_DIR:-}" ]]; then
  entry="${1##*/}"
  shift
  exec "$TEST_ACTIVATION_NODE" "$TEST_ACTIVATION_NATIVE_DIR/$entry" "$@"
fi
case "$1" in
  */validateRestoreLedgerCli.js)
    [[ ! -e "$TEST_ACTIVATION_WORK/fail-validation" ]] || exit 32 ;;
  */replayTenantDeletionsCli.js)
    [[ ! -e "$TEST_ACTIVATION_WORK/fail-replay" ]] || exit 1 ;;
  *) exit 33 ;;
esac
MOCK
cat > "$WORK/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_ACTIVATION_WORK/started"
MOCK
chmod +x "$WORK/bin/restic" "$WORK/bin/node" "$WORK/bin/systemctl"

run_block() {
  PATH="$WORK/bin:$PATH" SEMPREC_API_DATABASE_URL="${TEST_ACTIVATION_DATABASE_URL:-synthetic}" \
    SEMPREC_RESTORE_LEDGER="$WORK/ledger" bash "$WORK/activation.sh"
}
if [[ -n "${TEST_ACTIVATION_NATIVE_DIR:-}" ]]; then
  if run_block; then
    cp "$WORK/started" "$TEST_ACTIVATION_RESULT"
  else
    [[ ! -e "$WORK/started" ]]
    exit 1
  fi
  exit 0
fi
for failure in fail-fetch fail-validation fail-replay fail-missing-entry; do
  touch "$WORK/$failure"
  if run_block; then echo 'activation block unexpectedly succeeded' >&2; exit 1; fi
  [[ ! -e "$WORK/started" ]]
  rm "$WORK/$failure"
done
run_block
[[ "$(cat "$WORK/started")" == 'start semprec-api.service semprec-agents.service semprec-transcribe.service semprec-ai-gateway.service' ]]
echo 'Extracted activation block synthetic control passed'

# The database restore block of the same section, extracted the same way and run against shims that record
# every command, every argument and every script fed to psql.
awk '
  /<!-- restore-database-command:start -->/ { if (found++) exit 1; state = 1; next }
  /<!-- restore-database-command:end -->/ { if (state != 2) exit 1; state = 3; next }
  state == 1 && /^```bash$/ { state = 2; next }
  state == 2 && /^```$/ { next }
  state == 2 { print }
  END { if (found != 1 || state != 3) exit 1 }
' "$ROOT/deploy/README.md" > "$WORK/restore-database.sh"

readonly DB_WORK="$WORK/database"
readonly DB_BIN="$DB_WORK/bin"
readonly DB_LOG="$DB_WORK/calls"
readonly DB_SNAPSHOT=0123456789abcdef
readonly DB_OWNER_PASSWORD=owner-password-canary
readonly DB_DATA_PASSWORD=data-password-canary
readonly DB_SIDE_PASSWORD=side-password-canary
mkdir -p "$DB_BIN"
export TEST_DB_WORK="$DB_WORK"

cat > "$DB_BIN/psql" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
script="$(cat)"
if [[ "$*" == *"--set=owner="* ]]; then
  printf 'psql owner-check %s\n' "$*" >> "$TEST_DB_WORK/calls"
  printf '%s\n' "$script" >> "$TEST_DB_WORK/stdin"
  if [[ -e "$TEST_DB_WORK/fail-owner-missing" ]]; then echo 0; else echo 1; fi
else
  printf 'psql create-roles %s\n' "$*" >> "$TEST_DB_WORK/calls"
  printf '%s\n' "$script" >> "$TEST_DB_WORK/stdin"
  [[ ! -e "$TEST_DB_WORK/fail-create-roles" ]] || exit 51
fi
MOCK
cat > "$DB_BIN/pg_restore" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'pg_restore %s\n' "$*" >> "$TEST_DB_WORK/calls"
[[ ! -e "$TEST_DB_WORK/fail-pg-restore" ]] || exit 52
MOCK
cat > "$DB_BIN/restic" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  dump) printf 'restic-dump %s\n' "$*" >> "$TEST_DB_WORK/calls"; printf 'dump bytes of %s\n' "${!#}" ;;
  restore) printf 'restic-restore %s\n' "$*" >> "$TEST_DB_WORK/calls" ;;
  *) exit 53 ;;
esac
MOCK
cat > "$DB_BIN/node" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf 'node %s\n' "$*" >> "$TEST_DB_WORK/calls"
MOCK
chmod +x "$DB_BIN/psql" "$DB_BIN/pg_restore" "$DB_BIN/restic" "$DB_BIN/node"

reset_database_run() {
  rm -rf "$DB_WORK/calls" "$DB_WORK/stdin" "$DB_WORK/main.dump" "$DB_WORK/keys.dump" "$DB_WORK"/fail-*
}

run_database_block() {
  PATH="$DB_BIN:$PATH" \
    SEMPREC_RESTORE_OWNER=semprec_owner \
    SEMPREC_RESTORE_DATABASE=semprec \
    SEMPREC_RESTORE_SNAPSHOT="$DB_SNAPSHOT" \
    SEMPREC_RESTORE_MAIN_DUMP="$DB_WORK/main.dump" \
    SEMPREC_RESTORE_KEY_DUMP="$DB_WORK/keys.dump" \
    SEMPREC_DATA_DB_PASSWORD="$DB_DATA_PASSWORD" \
    SEMPREC_SIDE_DB_PASSWORD="$DB_SIDE_PASSWORD" \
    SEMPREC_RESTORE_ADMIN_URL=postgres://admin.invalid/semprec \
    SEMPREC_RESTORE_TARGET_URL=postgres://target.invalid/semprec \
    SEMPREC_RESTORE_CONTAINER="$(printf '%064d' 1)" \
    SEMPREC_RESTORE_RECEIPT="$DB_WORK/receipt" \
    PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD="$DB_OWNER_PASSWORD" \
    "$@" bash "$WORK/restore-database.sh"
}

# The steps run in this order, each one starting with the label the shim recorded for it.
reset_database_run
run_database_block env
expected_steps='psql owner-check
psql create-roles
restic-dump
pg_restore
restic-restore
restic-dump
node'
[[ "$(cut -d' ' -f1,2 "$DB_LOG" | awk '$1 == "restic-dump" || $1 == "restic-restore" || $1 == "pg_restore" || $1 == "node" { print $1; next } { print $1 " " $2 }')" == "$expected_steps" ]]

# The roles are created with the production attributes, before the dump, and the passwords reach psql through
# its environment, not through a script or an argument.
grep -q '^psql create-roles ' "$DB_LOG"
grep -q 'CREATE ROLE semprec_side LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;' "$DB_WORK/stdin"
grep -q 'CREATE ROLE semprec_data LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION IN ROLE semprec_side;' "$DB_WORK/stdin"
grep -q 'CREATE ROLE semprec_router NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;' "$DB_WORK/stdin"
grep -q '^\\getenv data_password SEMPREC_DATA_DB_PASSWORD$' "$DB_WORK/stdin"
grep -q "^ALTER ROLE semprec_data PASSWORD :'data_password';$" "$DB_WORK/stdin"
grep -q '^\\getenv side_password SEMPREC_SIDE_DB_PASSWORD$' "$DB_WORK/stdin"
grep -q "^ALTER ROLE semprec_side PASSWORD :'side_password';$" "$DB_WORK/stdin"
for secret in "$DB_DATA_PASSWORD" "$DB_SIDE_PASSWORD" "$DB_OWNER_PASSWORD"; do
  if grep -q -- "$secret" "$DB_LOG" "$DB_WORK/stdin"; then
    echo 'a password appeared in a recorded argument or script' >&2
    exit 1
  fi
done

# The production restore keeps owners and privileges.
test "$(grep -c '^pg_restore ' "$DB_LOG")" -eq 1
grep -q "^pg_restore --exit-on-error --dbname=semprec $DB_WORK/main.dump\$" "$DB_LOG"
if grep -q -e '--no-owner' -e '--no-privileges' "$DB_LOG"; then
  echo 'a restore command skipped owners or privileges' >&2
  exit 1
fi

# The main dump and both blob directories come from the one selected snapshot; the key dump is the newest one.
grep -qx "restic-dump dump $DB_SNAPSHOT /var/backups/semprec/postgres.dump" "$DB_LOG"
grep -qx "restic-restore restore $DB_SNAPSHOT --target / --include /opt/semprec/data/files --include /opt/semprec/data/mail-attachments" "$DB_LOG"
grep -qx 'restic-dump dump --path /var/backups/semprec/tenant-keys.dump latest /var/backups/semprec/tenant-keys.dump' "$DB_LOG"
[[ "$(cat "$DB_WORK/main.dump")" == 'dump bytes of /var/backups/semprec/postgres.dump' ]]
[[ "$(cat "$DB_WORK/keys.dump")" == 'dump bytes of /var/backups/semprec/tenant-keys.dump' ]]
# The key restore CLI is the last command and gets the key dump.
[[ "$(tail -n 1 "$DB_LOG")" == "node /opt/semprec/current/backend/packages/data/dist/tenancy/restoreTenantKeysCli.js $DB_WORK/keys.dump" ]]

# A missing owner role stops the block before any role is created and before pg_restore.
reset_database_run
touch "$DB_WORK/fail-owner-missing"
if run_database_block env; then echo 'a missing owner role unexpectedly succeeded' >&2; exit 1; fi
[[ "$(cat "$DB_LOG")" == psql\ owner-check\ * ]]
! grep -q -e '^pg_restore ' -e '^psql create-roles ' -e '^restic' -e '^node ' "$DB_LOG"

# Each later failure stops the steps after it.
reset_database_run
touch "$DB_WORK/fail-create-roles"
if run_database_block env; then echo 'a failed role statement unexpectedly succeeded' >&2; exit 1; fi
! grep -q -e '^pg_restore ' -e '^restic' -e '^node ' "$DB_LOG"
reset_database_run
touch "$DB_WORK/fail-pg-restore"
if run_database_block env; then echo 'a failed pg_restore unexpectedly succeeded' >&2; exit 1; fi
! grep -q -e '^restic-restore ' -e '^node ' "$DB_LOG"

# A missing input or a snapshot argument that is not an ID fails before any command runs.
for input in SEMPREC_RESTORE_OWNER SEMPREC_RESTORE_SNAPSHOT SEMPREC_DATA_DB_PASSWORD SEMPREC_SIDE_DB_PASSWORD \
  SEMPREC_RESTORE_KEY_DUMP SEMPREC_RESTORE_MAIN_DUMP PGPASSWORD; do
  reset_database_run
  if run_database_block env -u "$input"; then echo "$input unset unexpectedly succeeded" >&2; exit 1; fi
  [[ ! -e "$DB_LOG" ]]
done
reset_database_run
if run_database_block env SEMPREC_RESTORE_SNAPSHOT=--help; then echo 'an option as snapshot unexpectedly succeeded' >&2; exit 1; fi
[[ ! -e "$DB_LOG" ]]
echo 'Extracted restore database block synthetic control passed'
