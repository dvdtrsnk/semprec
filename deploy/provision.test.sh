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

mkdir -p "$TEST_BIN" "$TEST_STATE" "$TEST_ROOT/systemd/system" "$TEST_ROOT/caddy"
cp -R "$REPOSITORY_ROOT/deploy" "$TEST_DEPLOY"
mkdir -p "$TEST_STATE/hunspell" "$TEST_STATE/tsearch_data"
printf 'Czech dictionary\n' > "$TEST_STATE/hunspell/cs_CZ.dic"
printf 'Czech affix\n' > "$TEST_STATE/hunspell/cs_CZ.aff"
sed -i "s|readonly SEMPREC_ROOT=/opt/semprec|readonly SEMPREC_ROOT=$TEST_ROOT/opt/semprec|" \
  "$TEST_DEPLOY/provision.sh"
sed -i "s|readonly BACKUP_DIRECTORY=/var/backups/semprec|readonly BACKUP_DIRECTORY=$TEST_ROOT/var/backups/semprec|" \
  "$TEST_DEPLOY/provision.sh"
sed -i "s|readonly SYSTEMD_UNIT_DIR=/etc/systemd/system|readonly SYSTEMD_UNIT_DIR=$TEST_ROOT/systemd/system|" \
  "$TEST_DEPLOY/provision.sh"
sed -i "s|readonly JOURNALD_CONFIG_DIR=/etc/systemd/journald.conf.d|readonly JOURNALD_CONFIG_DIR=$TEST_ROOT/systemd/journald.conf.d|" \
  "$TEST_DEPLOY/provision.sh"
sed -i "s|readonly CADDY_CONFIG_DIR=/etc/caddy|readonly CADDY_CONFIG_DIR=$TEST_ROOT/caddy|" \
  "$TEST_DEPLOY/provision.sh"
sed -i "s|readonly CADDY_UNIT_DROPIN_DIR=/etc/systemd/system/caddy.service.d|readonly CADDY_UNIT_DROPIN_DIR=$TEST_ROOT/systemd/system/caddy.service.d|" \
  "$TEST_DEPLOY/provision.sh"
sed -i "s|readonly NFTABLES_CONFIG=/etc/nftables.conf|readonly NFTABLES_CONFIG=$TEST_ROOT/nftables.conf|" \
  "$TEST_DEPLOY/provision.sh"
sed -i "s|readonly APT_KEYRING_DIR=/etc/apt/keyrings|readonly APT_KEYRING_DIR=$TEST_ROOT/keyrings|" \
  "$TEST_DEPLOY/provision.sh"
sed -i "s|readonly APT_SOURCES_DIR=/etc/apt/sources.list.d|readonly APT_SOURCES_DIR=$TEST_ROOT/sources|" \
  "$TEST_DEPLOY/provision.sh"
sed -i "s|readonly HUNSPELL_DICT_SOURCE=/usr/share/hunspell/cs_CZ.dic|readonly HUNSPELL_DICT_SOURCE=$TEST_STATE/hunspell/cs_CZ.dic|" \
  "$TEST_DEPLOY/provision.sh"
sed -i "s|readonly HUNSPELL_AFFIX_SOURCE=/usr/share/hunspell/cs_CZ.aff|readonly HUNSPELL_AFFIX_SOURCE=$TEST_STATE/hunspell/cs_CZ.aff|" \
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
write_mock gpg 'cat > /dev/null; while [[ "$#" -gt 0 ]]; do if [[ "$1" == "--output" ]]; then printf key > "$2"; exit 0; fi; shift; done; exit 1'
write_mock dpkg 'echo amd64'
write_mock corepack 'echo "corepack $*" >> "$TEST_STATE/commands"'
write_mock systemctl 'echo "systemctl $*" >> "$TEST_STATE/commands"'
write_mock systemd-analyze 'echo "systemd-analyze $*" >> "$TEST_STATE/commands"'
write_mock install 'echo "install $*" >> "$TEST_STATE/commands"; args=(); while [[ "$#" -gt 0 ]]; do case "$1" in -o|-g) shift 2;; *) args+=("$1"); shift;; esac; done; /usr/bin/install "${args[@]}"'
write_mock docker '
if [[ "$1" == "compose" ]]; then
  echo "docker $*" >> "$TEST_STATE/commands"
  printf "postgres-container\\n"
  exit 0
fi
if [[ "$1" == "cp" ]]; then
  echo "docker cp $*" >> "$TEST_STATE/commands"
  cp "$2" "$TEST_STATE/tsearch_data/$(basename "${3#*:}")"
  exit 0
fi
if [[ "$1" == "exec" ]]; then
  shift
  if [[ "$1" == "--user" ]]; then shift 2; fi
  shift
  case "$1" in
    pg_config) printf "/mock/postgresql\\n"; exit 0 ;;
    sha256sum) sha256sum "$TEST_STATE/tsearch_data/$(basename "$2")"; exit $? ;;
    chmod) chmod "$2" "$TEST_STATE/tsearch_data/$(basename "$3")"; exit $? ;;
    test)
      if [[ "$2" == "-d" ]]; then test -d "$TEST_STATE/tsearch_data"; else test -s "$TEST_STATE/tsearch_data/$(basename "$3")" -a -r "$TEST_STATE/tsearch_data/$(basename "$3")"; fi
      exit $?
      ;;
    *) exit 1 ;;
  esac
fi'
write_mock caddy 'echo "caddy $*" >> "$TEST_STATE/commands"'
write_mock nft 'echo "nft $*" >> "$TEST_STATE/commands"'
write_mock chown 'echo "chown $*" >> "$TEST_STATE/commands"'
write_mock chmod 'echo "chmod $*" >> "$TEST_STATE/commands"; /bin/chmod "$@"'

run_provision() {
  PATH="$TEST_BIN:$PATH" bash "$TEST_DEPLOY/provision.sh"
}

run_provision 2> "$TEST_STATE/first-run.err" || { cat "$TEST_STATE/first-run.err" >&2; exit 1; }
test -d "$TEST_ROOT/opt/semprec/releases"
test -d "$TEST_ROOT/opt/semprec/shared"
for blob_dir in files mail-attachments; do
  test -d "$TEST_ROOT/opt/semprec/data/$blob_dir"
  test "$(stat -c %a "$TEST_ROOT/opt/semprec/data/$blob_dir")" -eq 750
  grep -Eq "^install -d -o semprec -g semprec -m 0750 .*/opt/semprec/data/$blob_dir\$" "$TEST_STATE/commands"
done
test -d "$TEST_ROOT/var/backups/semprec"
test "$(stat -c %a "$TEST_ROOT/var/backups/semprec")" -eq 700
readonly -a GROUPS_UNDER_TEST=(postgres migrate data-role side-role master-key gateway-token ai-gateway api agents settings backup monitor)
test "$(stat -c %a "$TEST_ROOT/opt/semprec/shared/env")" -eq 700
test "$(find "$TEST_ROOT/opt/semprec/shared/env" -type f | wc -l)" -eq 12
for group in "${GROUPS_UNDER_TEST[@]}"; do
  test "$(stat -c %a "$TEST_ROOT/opt/semprec/shared/env/$group.env")" -eq 600
  cmp "$TEST_DEPLOY/shared/env/$group.env.example" "$TEST_ROOT/opt/semprec/shared/env/$group.env"
done
test ! -e "$TEST_ROOT/opt/semprec/shared/.env"
test -f "$TEST_STATE/semprec-user"
test -f "$TEST_ROOT/systemd/system/semprec-api.service"
test -f "$TEST_ROOT/systemd/system/semprec-ai-gateway.service"
test -f "$TEST_ROOT/systemd/system/semprec-transcribe.service"
test -f "$TEST_ROOT/systemd/system/semprec-agents.service"
test -f "$TEST_ROOT/systemd/system/semprec-dead-man.timer"
test -f "$TEST_ROOT/systemd/system/semprec-failping@.service"
test -f "$TEST_ROOT/systemd/journald.conf.d/semprec.conf"
test -s "$TEST_STATE/tsearch_data/cs_cz.dict"
test -s "$TEST_STATE/tsearch_data/cs_cz.affix"
test -r "$TEST_STATE/tsearch_data/cs_cz.dict"
test -r "$TEST_STATE/tsearch_data/cs_cz.affix"
grep -q "^docker compose .*--env-file $TEST_ROOT/opt/semprec/shared/env/postgres.env " "$TEST_STATE/commands"
postgres_env_install_line="$(grep -m 1 -n "^install .*shared/env/postgres\.env\$" "$TEST_STATE/commands" | cut -d: -f1)"
compose_line="$(grep -m 1 -n "^docker compose " "$TEST_STATE/commands" | cut -d: -f1)"
test -n "$postgres_env_install_line"
test "$postgres_env_install_line" -lt "$compose_line"
grep -qx 'Storage=persistent' "$TEST_ROOT/systemd/journald.conf.d/semprec.conf"
grep -qx 'SystemMaxUse=2G' "$TEST_ROOT/systemd/journald.conf.d/semprec.conf"
grep -qx 'MaxRetentionSec=90day' "$TEST_ROOT/systemd/journald.conf.d/semprec.conf"
grep -qx 'SyslogIdentifier=semprec-api' "$TEST_ROOT/systemd/system/semprec-api.service"
grep -qx 'OnFailure=semprec-failping@%n.service' "$TEST_ROOT/systemd/system/semprec-api.service"
grep -qx 'SyslogIdentifier=semprec-agents' "$TEST_ROOT/systemd/system/semprec-agents.service"
grep -qx 'SyslogIdentifier=semprec-transcribe' "$TEST_ROOT/systemd/system/semprec-transcribe.service"
grep -qx 'SyslogIdentifier=semprec-ai-gateway' "$TEST_ROOT/systemd/system/semprec-ai-gateway.service"
grep -qx 'OnFailure=semprec-failping@%n.service' "$TEST_ROOT/systemd/system/semprec-agents.service"
grep -qx 'OnFailure=semprec-failping@%n.service' "$TEST_ROOT/systemd/system/semprec-transcribe.service"
grep -qx 'OnFailure=semprec-failping@%n.service' "$TEST_ROOT/systemd/system/semprec-ai-gateway.service"
grep -qx 'TimeoutStopSec=660' "$TEST_ROOT/systemd/system/semprec-ai-gateway.service"
for unit in semprec-api semprec-agents semprec-transcribe semprec-ai-gateway; do
  grep -qx 'EnvironmentFile=/opt/semprec/current/release.env' "$TEST_ROOT/systemd/system/$unit.service"
done

# Each unit loads exactly its own groups, in order, with release.env last on the long-running ones.
assert_unit_env_files() {
  local unit="$1"
  shift
  local expected=""
  local group
  for group in "$@"; do
    expected+="EnvironmentFile=/opt/semprec/shared/env/$group.env"$'\n'
  done
  if [[ "$unit" != *dead-man* && "$unit" != *failping* && "$unit" != *backup* && "$unit" != *restore-test* && "$unit" != *trash-purge* ]]; then
    expected+="EnvironmentFile=/opt/semprec/current/release.env"$'\n'
  fi
  test "$(grep '^EnvironmentFile=' "$TEST_ROOT/systemd/system/$unit")" = "${expected%$'\n'}"
}
assert_unit_env_files semprec-api.service data-role master-key gateway-token api settings
assert_unit_env_files semprec-agents.service data-role master-key gateway-token agents settings
assert_unit_env_files semprec-transcribe.service data-role gateway-token settings
assert_unit_env_files semprec-ai-gateway.service side-role gateway-token ai-gateway
assert_unit_env_files semprec-backup.service postgres settings backup
assert_unit_env_files semprec-restore-test.service side-role settings backup
assert_unit_env_files semprec-dead-man.service monitor
assert_unit_env_files semprec-failping@.service monitor
test "$(grep -c '^EnvironmentFile=' "$TEST_ROOT/systemd/system/semprec-trash-purge.service")" -eq 0
for unit_file in "$TEST_ROOT"/systemd/system/semprec-*.service; do
  if grep -Eq '/opt/semprec/shared/\.env|migrate\.env' "$unit_file"; then
    echo "$unit_file loads the legacy file or the migrate group" >&2
    exit 1
  fi
done
test "$(grep -l 'master-key\.env' "$TEST_ROOT"/systemd/system/semprec-*.service | xargs -n 1 basename | sort | tr '\n' ' ')" = 'semprec-agents.service semprec-api.service '
test "$(grep -l 'postgres\.env' "$TEST_ROOT"/systemd/system/semprec-*.service | xargs -n 1 basename)" = 'semprec-backup.service'

# The twelve templates partition the 52 keys: every key is declared exactly once.
all_template_keys="$(cat "$TEST_DEPLOY"/shared/env/*.env.example | grep -oE '^[A-Z_0-9]+=' | sort)"
test "$(wc -l <<<"$all_template_keys")" -eq 52
test -z "$(uniq -d <<<"$all_template_keys")"
for line in APP_BASE_URL= SMTP_HOST= SMTP_PORT=587 SMTP_SECURE=false SMTP_FROM_ADDRESS= SMTP_USER= SMTP_PASSWORD=; do
  test "$(grep -cx "$line" "$TEST_ROOT/opt/semprec/shared/env/api.env")" -eq 1
done
grep -q 'APP_BASE_URL is not set' "$TEST_STATE/first-run.err"
grep -q 'Outbound mail is not configured' "$TEST_STATE/first-run.err"

printf 'OPERATOR_CONFIGURED_SECRET=preserved\n' >> "$TEST_ROOT/opt/semprec/shared/env/settings.env"
settings_env_before="$(sha256sum "$TEST_ROOT/opt/semprec/shared/env/settings.env")"
rm "$TEST_ROOT/opt/semprec/shared/env/backup.env"
others_before="$(cd "$TEST_ROOT/opt/semprec/shared/env" && sha256sum $(ls | grep -v '^backup\.env$'))"
mkdir "$TEST_ROOT/opt/semprec/releases/release-one"
printf 'release payload\n' > "$TEST_ROOT/opt/semprec/releases/release-one/payload"
printf 'stored blob\n' > "$TEST_ROOT/opt/semprec/data/files/blob-one"
printf 'stored attachment\n' > "$TEST_ROOT/opt/semprec/data/mail-attachments/attachment-one"
first_run_commands="$(wc -l < "$TEST_STATE/commands")"
run_provision
tail -n +"$((first_run_commands + 1))" "$TEST_STATE/commands" > "$TEST_STATE/second-run-commands"

test "$(grep -c '^useradd$' "$TEST_STATE/commands")" -eq 1
grep -qx 'OPERATOR_CONFIGURED_SECRET=preserved' "$TEST_ROOT/opt/semprec/shared/env/settings.env"
test "$(sha256sum "$TEST_ROOT/opt/semprec/shared/env/settings.env")" = "$settings_env_before"
# A missing group file is installed from its template without touching the others.
cmp "$TEST_DEPLOY/shared/env/backup.env.example" "$TEST_ROOT/opt/semprec/shared/env/backup.env"
test "$(stat -c %a "$TEST_ROOT/opt/semprec/shared/env/backup.env")" -eq 600
test "$(cd "$TEST_ROOT/opt/semprec/shared/env" && sha256sum $(ls | grep -v '^backup\.env$'))" = "$others_before"
grep -qx 'release payload' "$TEST_ROOT/opt/semprec/releases/release-one/payload"
grep -qx 'stored blob' "$TEST_ROOT/opt/semprec/data/files/blob-one"
grep -qx 'stored attachment' "$TEST_ROOT/opt/semprec/data/mail-attachments/attachment-one"
if grep -q '/opt/semprec/data' "$TEST_STATE/second-run-commands"; then
  echo "second provision run re-created an existing data directory" >&2
  exit 1
fi
grep -q 'nodejs' "$TEST_STATE/commands"
grep -q 'docker-compose-plugin' "$TEST_STATE/commands"
grep -q 'caddy' "$TEST_STATE/commands"
grep -q 'restic' "$TEST_STATE/commands"
grep -q 'ffmpeg' "$TEST_STATE/commands"
grep -q 'hunspell-cs' "$TEST_STATE/commands"
grep -q 'nftables' "$TEST_STATE/commands"
test "$(grep -c '^docker cp ' "$TEST_STATE/commands")" -eq 2

test -f "$TEST_ROOT/caddy/Caddyfile"
test -f "$TEST_ROOT/systemd/system/caddy.service.d/semprec.conf"
test ! -f "$TEST_ROOT/caddy/semprec.env"
test "$(grep -c '^systemctl enable caddy$' "$TEST_STATE/commands")" -eq 0

printf 'SEMPREC_DOMAIN=example.test\n' >> "$TEST_ROOT/opt/semprec/shared/env/monitor.env"
run_provision
grep -qx 'SEMPREC_DOMAIN=example.test' "$TEST_ROOT/caddy/semprec.env"
test "$(wc -l < "$TEST_ROOT/caddy/semprec.env")" -eq 1
test "$(grep -c '^caddy validate ' "$TEST_STATE/commands")" -eq 1
test "$(grep -c '^systemctl reload-or-restart caddy$' "$TEST_STATE/commands")" -eq 1

semprec_env_before="$(cat "$TEST_ROOT/caddy/semprec.env")"
run_provision
test "$(cat "$TEST_ROOT/caddy/semprec.env")" = "$semprec_env_before"
test "$(grep -c '^caddy validate ' "$TEST_STATE/commands")" -eq 2
test "$(grep -c '^systemctl reload-or-restart caddy$' "$TEST_STATE/commands")" -eq 2

readonly SECRET_SENTINEL='smtp-password-sentinel-7f3a'
printf 'APP_BASE_URL=https://example.test\nSMTP_HOST=smtp.example.test\nSMTP_FROM_ADDRESS=no-reply@example.test\nSMTP_PASSWORD=%s\n' \
  "$SECRET_SENTINEL" >> "$TEST_ROOT/opt/semprec/shared/env/api.env"
env_before="$(sha256sum "$TEST_ROOT/opt/semprec/shared/env/api.env")"
run_provision >"$TEST_STATE/consistent.out" 2>"$TEST_STATE/consistent.err"
if grep -Eq 'APP_BASE_URL|Outbound mail' "$TEST_STATE/consistent.err"; then
  echo 'provision warned although the outbound link settings are consistent' >&2
  exit 1
fi
if grep -rq "$SECRET_SENTINEL" "$TEST_STATE/consistent.out" "$TEST_STATE/consistent.err"; then
  echo 'provision printed SMTP_PASSWORD' >&2
  exit 1
fi
test "$(sha256sum "$TEST_ROOT/opt/semprec/shared/env/api.env")" = "$env_before"

printf 'APP_BASE_URL=https://other.test\n' >> "$TEST_ROOT/opt/semprec/shared/env/api.env"
run_provision >/dev/null 2>"$TEST_STATE/mismatch.err"
grep -q 'https://other.test' "$TEST_STATE/mismatch.err"
grep -q 'example.test' "$TEST_STATE/mismatch.err"
if grep -q "$SECRET_SENTINEL" "$TEST_STATE/mismatch.err"; then
  echo 'provision printed SMTP_PASSWORD' >&2
  exit 1
fi
sed -i '/^APP_BASE_URL=https:\/\/other.test$/d' "$TEST_ROOT/opt/semprec/shared/env/api.env"

test -f "$TEST_ROOT/nftables.conf"
grep -qx 'table inet semprec' "$TEST_ROOT/nftables.conf"
if grep -q '^flush ruleset' "$TEST_ROOT/nftables.conf"; then
  echo "nftables.conf flushes the whole ruleset, which would delete Docker's own tables" >&2
  exit 1
fi
grep -qE '^\s*type filter hook output priority 0; policy accept;$' "$TEST_ROOT/nftables.conf"
grep -qE '^\s*meta skuid "semprec" jump semprec_egress$' "$TEST_ROOT/nftables.conf"
for element in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4 ::/128 ::1/128 ::ffff:0:0/96 64:ff9b::/96 64:ff9b:1::/48 100::/64 fc00::/7 fe80::/10 ff00::/8; do
  grep -qF -- "$element" "$TEST_ROOT/nftables.conf"
done
grep -qE '^\s*set semprec_blocked_v4 \{' "$TEST_ROOT/nftables.conf"
grep -qE '^\s*set semprec_blocked_v6 \{' "$TEST_ROOT/nftables.conf"
egress_rules="$(awk '/chain semprec_egress \{/{f=1;next} f&&/^\t\}/{exit} f&&NF' "$TEST_ROOT/nftables.conf" | sed 's/^[[:space:]]*//')"
test "$(head -n 1 <<<"$egress_rules")" = 'ct state established,related accept'
grep -qx 'tcp dport 53 accept' <<<"$egress_rules"
grep -qx 'udp dport 53 accept' <<<"$egress_rules"
grep -qx 'meta l4proto tcp ct original ip daddr 127.0.0.1 ct original proto-dst { 5432, 3002 } accept' <<<"$egress_rules"
grep -qx 'ip daddr @semprec_blocked_v4 reject with icmpx type admin-prohibited' <<<"$egress_rules"
grep -qx 'ip6 daddr @semprec_blocked_v6 reject with icmpx type admin-prohibited' <<<"$egress_rules"
test "$(grep -c 'semprec-egress-deny ' <<<"$egress_rules")" -eq 2
grep -q "^nft -c -f $TEST_ROOT/nftables.conf$" "$TEST_STATE/commands"
grep -qx 'systemctl enable nftables' "$TEST_STATE/commands"
grep -qx 'systemctl reload-or-restart nftables' "$TEST_STATE/commands"

test "$(stat -c %a "$TEST_ROOT/opt/semprec/shared")" -eq 750
test "$(stat -c %a "$TEST_ROOT/opt/semprec/shared/bin")" -eq 750
grep -qx "chown root:semprec $TEST_ROOT/opt/semprec/shared" "$TEST_STATE/commands"
grep -qx "chown root:semprec $TEST_ROOT/opt/semprec/shared/bin" "$TEST_STATE/commands"
grep -qx "chown root:root $TEST_ROOT/opt/semprec/shared/env" "$TEST_STATE/commands"
grep -qx "chmod 0700 $TEST_ROOT/opt/semprec/shared/env" "$TEST_STATE/commands"
for group in "${GROUPS_UNDER_TEST[@]}"; do
  grep -qx "chown root:root $TEST_ROOT/opt/semprec/shared/env/$group.env" "$TEST_STATE/commands"
  grep -qx "chmod 0600 $TEST_ROOT/opt/semprec/shared/env/$group.env" "$TEST_STATE/commands"
done
# No legacy file exists on this host, so none is healed.
if grep -q "shared/\.env\$" "$TEST_STATE/commands"; then
  echo 'provision touched a legacy shared/.env that does not exist' >&2
  exit 1
fi
grep -Eq "^install -o root -g semprec -m 0750 .*/shared/bin/semprec-dead-man\.sh\$" "$TEST_STATE/commands"
if grep -q 'apns-key.p8' "$TEST_STATE/commands"; then
  echo "provision recorded an apns-key.p8 command although the file does not exist" >&2
  exit 1
fi

touch "$TEST_ROOT/opt/semprec/shared/apns-key.p8"
run_provision
grep -qx "chown root:semprec $TEST_ROOT/opt/semprec/shared/apns-key.p8" "$TEST_STATE/commands"
grep -qx "chmod 0640 $TEST_ROOT/opt/semprec/shared/apns-key.p8" "$TEST_STATE/commands"
test "$(stat -c %a "$TEST_ROOT/opt/semprec/shared/apns-key.p8")" -eq 640

# ---- Splitting a legacy single file into the group files. ----
rm -rf "$TEST_ROOT/opt/semprec/shared/env"
legacy_env="$TEST_ROOT/opt/semprec/shared/.env"
{
  printf 'APP_BASE_URL=stale-first-definition\n'
  while IFS= read -r key; do
    case "$key" in
      # Consistent with each other so the (value-printing) link warning stays quiet.
      APP_BASE_URL) printf 'APP_BASE_URL=https://example.test\n' ;;
      SEMPREC_DOMAIN) printf 'SEMPREC_DOMAIN=example.test\n' ;;
      *) printf '%s=legacy-value-%s-4d1e\n' "$key" "$key" ;;
    esac
  done <<<"$(sed 's/=$//' <<<"$all_template_keys")"
  printf 'UNCLAIMED_LEGACY_KEY=legacy-value-unclaimed-4d1e\n'
} > "$legacy_env"
legacy_before="$(sha256sum "$legacy_env")"
run_provision >"$TEST_STATE/legacy.out" 2>"$TEST_STATE/legacy.err"
test "$(sha256sum "$legacy_env")" = "$legacy_before"
grep -q 'UNCLAIMED_LEGACY_KEY' "$TEST_STATE/legacy.err"
grep -q 'no longer read' "$TEST_STATE/legacy.err"
if grep -rq 'legacy-value-\|stale-first-definition' "$TEST_STATE/legacy.out" "$TEST_STATE/legacy.err"; then
  echo 'provision printed a legacy value' >&2
  exit 1
fi
for group in "${GROUPS_UNDER_TEST[@]}"; do
  group_file="$TEST_ROOT/opt/semprec/shared/env/$group.env"
  test "$(stat -c %a "$group_file")" -eq 600
  expected_keys="$(grep -oE '^[A-Z_0-9]+=' "$TEST_DEPLOY/shared/env/$group.env.example")"
  test "$(grep -oE '^[A-Z_0-9]+=' "$group_file")" = "$expected_keys"
  while IFS= read -r key_line; do
    key="${key_line%=}"
    test "$(grep -c "^$key=" "$group_file")" -eq 1
    grep -qxF "$(grep "^$key=" "$legacy_env" | tail -n 1)" "$group_file"
  done <<<"$expected_keys"
done
if grep -rq 'UNCLAIMED_LEGACY_KEY' "$TEST_ROOT/opt/semprec/shared/env"; then
  echo 'an unclaimed legacy key was copied into a group file' >&2
  exit 1
fi

chmod 000 "$TEST_STATE/hunspell/cs_CZ.dic"
if run_provision >"$TEST_STATE/unreadable-asset.out" 2>&1; then
  echo 'provision unexpectedly succeeded with an unreadable Czech dictionary' >&2
  exit 1
fi
grep -q 'Czech Hunspell asset is missing, empty, or unreadable' "$TEST_STATE/unreadable-asset.out"

rm "$TEST_STATE/hunspell/cs_CZ.dic"
if run_provision >"$TEST_STATE/missing-asset.out" 2>&1; then
  echo 'provision unexpectedly succeeded without the Czech dictionary' >&2
  exit 1
fi
grep -q 'Czech Hunspell asset is missing, empty, or unreadable' "$TEST_STATE/missing-asset.out"

for unit in semprec-api semprec-agents semprec-transcribe semprec-ai-gateway; do
  grep -qx 'StartLimitIntervalSec=15min' "$TEST_ROOT/systemd/system/$unit.service"
  grep -qx 'StartLimitBurst=180' "$TEST_ROOT/systemd/system/$unit.service"
done

grep -qx 'TimeoutStopSec=960' "$TEST_ROOT/systemd/system/semprec-transcribe.service"

echo 'provision.sh idempotence test passed'
