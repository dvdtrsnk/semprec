#!/usr/bin/env bash
# Hermetic idempotence test for deploy/provision.sh.
set -euo pipefail

readonly REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly TEST_ROOT="$(mktemp -d)"
readonly TEST_DEPLOY="$TEST_ROOT/deploy"
readonly TEST_BIN="$TEST_ROOT/bin"
readonly TEST_STATE="$TEST_ROOT/state"
export TEST_STATE

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$TEST_BIN" "$TEST_STATE" "$TEST_ROOT/systemd/system"
cp -R "$REPOSITORY_ROOT/deploy" "$TEST_DEPLOY"
sed -i "s|readonly SEMPREC_ROOT=/opt/semprec|readonly SEMPREC_ROOT=$TEST_ROOT/opt/semprec|" \
  "$TEST_DEPLOY/provision.sh"
sed -i "s|readonly BACKUP_DIRECTORY=/var/backups/semprec|readonly BACKUP_DIRECTORY=$TEST_ROOT/var/backups/semprec|" \
  "$TEST_DEPLOY/provision.sh"
sed -i "s|readonly SYSTEMD_UNIT_DIR=/etc/systemd/system|readonly SYSTEMD_UNIT_DIR=$TEST_ROOT/systemd/system|" \
  "$TEST_DEPLOY/provision.sh"
sed -i "s|readonly JOURNALD_CONFIG_DIR=/etc/systemd/journald.conf.d|readonly JOURNALD_CONFIG_DIR=$TEST_ROOT/systemd/journald.conf.d|" \
  "$TEST_DEPLOY/provision.sh"
sed -i "s|readonly APT_KEYRING_DIR=/etc/apt/keyrings|readonly APT_KEYRING_DIR=$TEST_ROOT/keyrings|" \
  "$TEST_DEPLOY/provision.sh"
sed -i "s|readonly APT_SOURCES_DIR=/etc/apt/sources.list.d|readonly APT_SOURCES_DIR=$TEST_ROOT/sources|" \
  "$TEST_DEPLOY/provision.sh"

write_mock() {
  local name="$1"
  local body="$2"
  printf '#!/usr/bin/env bash\nset -euo pipefail\n%s\n' "$body" > "$TEST_BIN/$name"
  chmod +x "$TEST_BIN/$name"
}

write_mock id 'if [[ "${1:-}" == "-u" ]]; then echo 0; fi'
write_mock getent '[[ "${1:-}" == "passwd" && "${2:-}" == "semprec" && -f "$TEST_STATE/semprec-user" ]]'
write_mock useradd 'touch "$TEST_STATE/semprec-user"; echo useradd >> "$TEST_STATE/commands"'
write_mock apt-get 'echo "apt-get $*" >> "$TEST_STATE/commands"'
write_mock curl 'printf key'
write_mock gpg 'while [[ "$#" -gt 0 ]]; do if [[ "$1" == "--output" ]]; then printf key > "$2"; exit 0; fi; shift; done; exit 1'
write_mock dpkg 'echo amd64'
write_mock corepack 'echo "corepack $*" >> "$TEST_STATE/commands"'
write_mock systemctl 'echo "systemctl $*" >> "$TEST_STATE/commands"'
write_mock systemd-analyze 'echo "systemd-analyze $*" >> "$TEST_STATE/commands"'
write_mock install 'args=(); while [[ "$#" -gt 0 ]]; do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done; /usr/bin/install "${args[@]}"'

run_provision() {
  PATH="$TEST_BIN:$PATH" bash "$TEST_DEPLOY/provision.sh"
}

run_provision
test -d "$TEST_ROOT/opt/semprec/releases"
test -d "$TEST_ROOT/opt/semprec/shared"
test -d "$TEST_ROOT/var/backups/semprec"
test "$(stat -c %a "$TEST_ROOT/var/backups/semprec")" -eq 700
test -f "$TEST_ROOT/opt/semprec/shared/.env"
test -f "$TEST_STATE/semprec-user"
test -f "$TEST_ROOT/systemd/system/semprec-api.service"
test -f "$TEST_ROOT/systemd/system/semprec-ai-gateway.service"
test -f "$TEST_ROOT/systemd/system/semprec-mailsync@.service"
test -f "$TEST_ROOT/systemd/system/semprec-transcribe.service"
test -f "$TEST_ROOT/systemd/system/semprec-agents.service"
test -f "$TEST_ROOT/systemd/system/semprec-dead-man.timer"
test -f "$TEST_ROOT/systemd/journald.conf.d/semprec.conf"

printf 'OPERATOR_CONFIGURED_SECRET=preserved\n' > "$TEST_ROOT/opt/semprec/shared/.env"
mkdir "$TEST_ROOT/opt/semprec/releases/release-one"
printf 'release payload\n' > "$TEST_ROOT/opt/semprec/releases/release-one/payload"
run_provision

test "$(grep -c '^useradd$' "$TEST_STATE/commands")" -eq 1
grep -qx 'OPERATOR_CONFIGURED_SECRET=preserved' "$TEST_ROOT/opt/semprec/shared/.env"
grep -qx 'release payload' "$TEST_ROOT/opt/semprec/releases/release-one/payload"
grep -q 'nodejs' "$TEST_STATE/commands"
grep -q 'docker-compose-plugin' "$TEST_STATE/commands"
grep -q 'caddy' "$TEST_STATE/commands"
grep -q 'restic' "$TEST_STATE/commands"
grep -q 'ffmpeg' "$TEST_STATE/commands"

echo 'provision.sh idempotence test passed'
