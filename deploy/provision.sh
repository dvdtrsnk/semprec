#!/usr/bin/env bash
# Provision a Debian or Ubuntu host for the first Semprec deployment.
set -euo pipefail

readonly SEMPREC_ROOT=/opt/semprec
readonly BACKUP_DIRECTORY=/var/backups/semprec
readonly SYSTEMD_UNIT_DIR=/etc/systemd/system
readonly JOURNALD_CONFIG_DIR=/etc/systemd/journald.conf.d
readonly CADDY_CONFIG_DIR=/etc/caddy
readonly CADDY_UNIT_DROPIN_DIR=/etc/systemd/system/caddy.service.d
readonly NFTABLES_CONFIG=/etc/nftables.conf
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly APT_KEYRING_DIR=/etc/apt/keyrings
readonly APT_SOURCES_DIR=/etc/apt/sources.list.d
# PostgreSQL rejects dictionary file basenames with uppercase letters, so the assets are
# installed lowercase; backend migration 0046 references them as cs_cz.
readonly HUNSPELL_BASENAME=cs_cz
readonly HUNSPELL_DICT_SOURCE=/usr/share/hunspell/cs_CZ.dic
readonly HUNSPELL_AFFIX_SOURCE=/usr/share/hunspell/cs_CZ.aff

# Every key lives in exactly one group file, shared/env/<group>.env, installed from
# shared/env/<group>.env.example (docs/adr/2026-10-03-per-service-secret-groups.md).
readonly -a SECRET_GROUPS=(
  postgres
  migrate
  data-role
  side-role
  master-key
  gateway-token
  ai-gateway
  api
  agents
  settings
  backup
  monitor
)

readonly -a SERVICE_UNITS=(
  semprec-api.service
  semprec-agents.service
  semprec-transcribe.service
  semprec-ai-gateway.service
)

readonly -a TIMER_UNITS=(
  semprec-dead-man.timer
  semprec-backup.timer
  semprec-restore-test.timer
  semprec-trash-purge.timer
)

readonly -a TIMER_SERVICES=(
  semprec-dead-man.service
  semprec-backup.service
  semprec-restore-test.service
  semprec-trash-purge.service
)

readonly -a FAILURE_SERVICE_UNITS=(
  semprec-failping@.service
)

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "provision.sh must run as root" >&2
    exit 1
  fi
}

require_supported_distribution() {
  if [[ ! -r /etc/os-release ]]; then
    echo "Cannot identify the operating system: /etc/os-release is unavailable" >&2
    exit 1
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "debian" && "${ID:-}" != "ubuntu" ]]; then
    echo "Unsupported distribution: ${ID:-unknown}; expected Debian or Ubuntu" >&2
    exit 1
  fi
}

install_apt_repositories() {
  install -d -m 0755 "$APT_KEYRING_DIR"
  install -d -m 0755 "$APT_SOURCES_DIR"

  curl -fsSL https://download.docker.com/linux/"$ID"/gpg |
    gpg --dearmor --yes --output "$APT_KEYRING_DIR/docker.gpg"
  chmod a+r "$APT_KEYRING_DIR/docker.gpg"
  printf 'deb [arch=%s signed-by=%s] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$APT_KEYRING_DIR/docker.gpg" "$ID" "$VERSION_CODENAME" \
    > "$APT_SOURCES_DIR/docker.list"

  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor --yes --output "$APT_KEYRING_DIR/nodesource.gpg"
  chmod a+r "$APT_KEYRING_DIR/nodesource.gpg"
  printf 'deb [signed-by=%s] https://deb.nodesource.com/node_22.x nodistro main\n' \
    "$APT_KEYRING_DIR/nodesource.gpg" > "$APT_SOURCES_DIR/nodesource.list"
}

install_host_packages() {
  apt-get update
  apt-get install --yes --no-install-recommends ca-certificates curl gnupg
  install_apt_repositories
  apt-get update
  apt-get install --yes --no-install-recommends \
    nodejs \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin \
    caddy \
    nftables \
    restic \
    ffmpeg \
    hunspell-cs
  corepack enable pnpm
}

require_readable_hunspell_asset() {
  local path="$1"
  local mode

  if [[ ! -s "$path" || ! -r "$path" ]]; then
    echo "Czech Hunspell asset is missing, empty, or unreadable: $path" >&2
    exit 1
  fi

  mode="$(stat --format '%a' "$path")"
  if (( (8#$mode & 0444) == 0 )); then
    echo "Czech Hunspell asset is missing, empty, or unreadable: $path" >&2
    exit 1
  fi
}

copy_hunspell_asset() {
  local postgres_container="$1"
  local source="$2"
  local destination="$3"
  local source_checksum
  local destination_checksum

  source_checksum="$(sha256sum "$source" | awk '{print $1}')"
  destination_checksum="$(docker exec "$postgres_container" sha256sum "$destination" 2>/dev/null | awk '{print $1}' || true)"

  if [[ "$source_checksum" != "$destination_checksum" ]]; then
    docker cp "$source" "$postgres_container:$destination"
  fi

  # The image's PostgreSQL process runs as an unprivileged user. Docker copies files
  # as root, so fix their mode only when that user cannot read the copied asset.
  if ! docker exec --user postgres "$postgres_container" test -s "$destination" -a -r "$destination"; then
    docker exec --user root "$postgres_container" chmod 0644 "$destination"
  fi
  if ! docker exec --user postgres "$postgres_container" test -s "$destination" -a -r "$destination"; then
    echo "Installed Czech Hunspell asset is empty or unreadable: $destination" >&2
    exit 1
  fi
}

install_postgresql_hunspell_assets() {
  require_readable_hunspell_asset "$HUNSPELL_DICT_SOURCE"
  require_readable_hunspell_asset "$HUNSPELL_AFFIX_SOURCE"

  local postgres_container
  if ! postgres_container="$(docker compose --env-file "$SEMPREC_ROOT/shared/env/postgres.env" -f "$SCRIPT_DIR/docker-compose.yml" ps --quiet postgres)" || [[ -z "$postgres_container" ]]; then
    echo "Cannot install Czech Hunspell assets: the PostgreSQL container is not active" >&2
    exit 1
  fi

  local postgres_sharedir
  if ! postgres_sharedir="$(docker exec "$postgres_container" pg_config --sharedir)" || [[ -z "$postgres_sharedir" ]]; then
    echo "Cannot locate PostgreSQL tsearch_data: pg_config returned an empty sharedir" >&2
    exit 1
  fi

  local tsearch_data_dir="$postgres_sharedir/tsearch_data"
  if ! docker exec "$postgres_container" test -d "$tsearch_data_dir"; then
    echo "Cannot locate PostgreSQL tsearch_data directory: $tsearch_data_dir" >&2
    exit 1
  fi

  copy_hunspell_asset "$postgres_container" "$HUNSPELL_DICT_SOURCE" "$tsearch_data_dir/$HUNSPELL_BASENAME.dict"
  copy_hunspell_asset "$postgres_container" "$HUNSPELL_AFFIX_SOURCE" "$tsearch_data_dir/$HUNSPELL_BASENAME.affix"
}

ensure_service_user() {
  if ! getent passwd semprec >/dev/null; then
    useradd --system --user-group --home-dir "$SEMPREC_ROOT" --shell /usr/sbin/nologin semprec
  fi
}

ensure_directory() {
  local path="$1"
  local mode="$2"
  local owner="${3:-root}"

  if [[ -e "$path" && ! -d "$path" ]]; then
    echo "Expected directory at $path, found another file type" >&2
    exit 1
  fi
  if [[ ! -e "$path" ]]; then
    install -d -o "$owner" -g "$owner" -m "$mode" "$path"
  fi
}

ensure_release_tree() {
  ensure_directory "$SEMPREC_ROOT" 0755
  ensure_directory "$SEMPREC_ROOT/releases" 0755
  ensure_directory "$SEMPREC_ROOT/shared" 0700
  ensure_directory "$SEMPREC_ROOT/shared/bin" 0750
  # Blob bytes live beside `shared` (0700 root:root, not traversable by the `semprec` services),
  # never under /tmp, which is cleaned on reboot while the `blobs` rows referencing them survive.
  ensure_directory "$SEMPREC_ROOT/data" 0755
  ensure_directory "$SEMPREC_ROOT/data/files" 0750 semprec
  ensure_directory "$SEMPREC_ROOT/data/mail-attachments" 0750 semprec

  ensure_directory "$SEMPREC_ROOT/shared/env" 0700
  install_secret_groups
}

# Prints the template's own `KEY=` lines, each replaced by the legacy file's last `KEY=` line
# verbatim when it has one. The legacy path is read as a file, never through argv, so no value
# reaches a process listing.
render_group_from_legacy() {
  local legacy_env="$1"
  local template="$2"

  awk '
    FILENAME == ARGV[1] {
      if (match($0, /^[A-Za-z_][A-Za-z0-9_]*=/)) {
        legacy[substr($0, 1, RLENGTH - 1)] = $0
      }
      next
    }
    {
      if (match($0, /^[A-Za-z_][A-Za-z0-9_]*=/) && (substr($0, 1, RLENGTH - 1) in legacy)) {
        print legacy[substr($0, 1, RLENGTH - 1)]
      } else {
        print
      }
    }
  ' "$legacy_env" "$template"
}

# Prints the names (never values) of legacy keys that no group template declares.
report_unclaimed_legacy_keys() {
  local legacy_env="$1"
  local group
  local -a templates=()
  for group in "${SECRET_GROUPS[@]}"; do
    templates+=("$SCRIPT_DIR/shared/env/$group.env.example")
  done

  local unclaimed
  unclaimed="$(awk '
    FNR == NR {
      if (match($0, /^[A-Za-z_][A-Za-z0-9_]*=/)) {
        claimed[substr($0, 1, RLENGTH - 1)] = 1
      }
      next
    }
    FILENAME == ARGV[ARGC - 1] {
      if (match($0, /^[A-Za-z_][A-Za-z0-9_]*=/)) {
        name = substr($0, 1, RLENGTH - 1)
        if (!(name in claimed) && !(name in reported)) {
          reported[name] = 1
          print name
        }
      }
    }
  ' <(cat "${templates[@]}") "$legacy_env")"

  echo "$legacy_env is no longer read by any unit or script; the values now live in $SEMPREC_ROOT/shared/env/*.env. Verify them, then delete it by hand." >&2
  if [[ -n "$unclaimed" ]]; then
    echo "Legacy keys that no group claims (not copied): $(tr '\n' ' ' <<<"$unclaimed")" >&2
  fi
}

# Installs a group file for every template whose file does not exist yet — an existing group
# file is an operator's and is never overwritten. When the legacy single file is present its
# values seed the new files; it is never modified or removed. Never prints a value.
install_secret_groups() {
  local legacy_env="$SEMPREC_ROOT/shared/.env"
  local has_legacy=0
  if [[ -e "$legacy_env" ]]; then
    has_legacy=1
  fi

  local group template destination tmp_group
  for group in "${SECRET_GROUPS[@]}"; do
    template="$SCRIPT_DIR/shared/env/$group.env.example"
    destination="$SEMPREC_ROOT/shared/env/$group.env"
    if [[ -e "$destination" || -L "$destination" ]]; then
      continue
    fi
    if (( has_legacy )); then
      tmp_group="$(mktemp)"
      render_group_from_legacy "$legacy_env" "$template" > "$tmp_group"
      install -o root -g root -m 0600 "$tmp_group" "$destination"
      rm -f "$tmp_group"
    else
      install -o root -g root -m 0600 "$template" "$destination"
    fi
  done

  if (( has_legacy )); then
    report_unclaimed_legacy_keys "$legacy_env"
  fi
}

ensure_backup_directory() {
  ensure_directory "$BACKUP_DIRECTORY" 0700
}

install_systemd_units() {
  local unit
  for unit in "${SERVICE_UNITS[@]}" "${TIMER_SERVICES[@]}" "${TIMER_UNITS[@]}" "${FAILURE_SERVICE_UNITS[@]}"; do
    install -o root -g root -m 0644 "$SCRIPT_DIR/systemd/$unit" "$SYSTEMD_UNIT_DIR/$unit"
  done

  install -d -o root -g root -m 0755 "$JOURNALD_CONFIG_DIR"
  install -o root -g root -m 0644 \
    "$SCRIPT_DIR/systemd/journald-semprec.conf" \
    "$JOURNALD_CONFIG_DIR/semprec.conf"
}

install_timer_scripts() {
  local script
  for script in dead-man failping backup restore-test trash-purge; do
    install -o root -g semprec -m 0750 \
      "$SCRIPT_DIR/systemd/scripts/semprec-$script.sh" \
      "$SEMPREC_ROOT/shared/bin/semprec-$script.sh"
  done
}

verify_systemd_units() {
  local -a unit_paths=()
  local unit
  for unit in "${SERVICE_UNITS[@]}" "${TIMER_SERVICES[@]}" "${TIMER_UNITS[@]}" "${FAILURE_SERVICE_UNITS[@]}"; do
    unit_paths+=("$SYSTEMD_UNIT_DIR/$unit")
  done
  systemd-analyze verify "${unit_paths[@]}"
}

enable_timers() {
  local timer
  for timer in "${TIMER_UNITS[@]}"; do
    systemctl enable --now "$timer"
  done
}

install_caddy_config() {
  install -o root -g root -m 0644 "$SCRIPT_DIR/Caddyfile" "$CADDY_CONFIG_DIR/Caddyfile"
  install -d -o root -g root -m 0755 "$CADDY_UNIT_DROPIN_DIR"
  install -o root -g root -m 0644 \
    "$SCRIPT_DIR/systemd/caddy-semprec.conf" \
    "$CADDY_UNIT_DROPIN_DIR/semprec.conf"
}

render_caddy_environment() {
  local domain
  local monitor_env="$SEMPREC_ROOT/shared/env/monitor.env"
  domain="$(sed -n 's/^SEMPREC_DOMAIN=//p' "$monitor_env" | tail -n 1)"

  if [[ -z "$domain" ]]; then
    echo "SEMPREC_DOMAIN is not set in $monitor_env; Caddy stays unconfigured until it is set and provision.sh is rerun" >&2
    return 0
  fi

  local tmp_env
  tmp_env="$(mktemp)"
  printf 'SEMPREC_DOMAIN=%s\n' "$domain" > "$tmp_env"
  install -o root -g root -m 0600 "$tmp_env" "$CADDY_CONFIG_DIR/semprec.env"
  rm -f "$tmp_env"

  systemctl daemon-reload
  systemctl enable caddy
  SEMPREC_DOMAIN="$domain" caddy validate --config "$CADDY_CONFIG_DIR/Caddyfile"
  systemctl reload-or-restart caddy
}

install_nftables_config() {
  install -o root -g root -m 0644 "$SCRIPT_DIR/nftables.conf" "$NFTABLES_CONFIG"
}

apply_nftables() {
  nft -c -f "$NFTABLES_CONFIG"
  systemctl enable nftables
  systemctl reload-or-restart nftables
}

# The `semprec` services and timer scripts need to read `shared/` and `shared/bin`, but
# ensure_directory only sets the mode when it creates a directory, so an already-provisioned
# host needs its existing mode corrected on every run instead.
ensure_shared_permissions() {
  local shared_dir="$SEMPREC_ROOT/shared"
  local bin_dir="$shared_dir/bin"
  local env_dir="$shared_dir/env"
  local legacy_env="$shared_dir/.env"
  local apns_key="$shared_dir/apns-key.p8"

  chown root:semprec "$shared_dir"
  chmod 0750 "$shared_dir"
  chown root:semprec "$bin_dir"
  chmod 0750 "$bin_dir"

  # systemd reads EnvironmentFile= as root before dropping privileges, so no service user
  # needs these files; a hand-edited mode is healed back on every rerun. The legacy file is
  # only healed when it still exists.
  chown root:root "$env_dir"
  chmod 0700 "$env_dir"
  local group_file
  for group_file in "$env_dir"/*.env; do
    [[ -e "$group_file" ]] || continue
    chown root:root "$group_file"
    chmod 0600 "$group_file"
  done
  if [[ -e "$legacy_env" ]]; then
    chown root:root "$legacy_env"
    chmod 0600 "$legacy_env"
  fi

  if [[ -e "$apns_key" ]]; then
    chown root:semprec "$apns_key"
    chmod 0640 "$apns_key"
  fi
}

# Warns, never fails: an operator's group files are never edited, and the settings below are only
# consequential once semprec-api sends mail. Prints key names and the two non-secret URL values only.
check_outbound_link_settings() {
  local env_file="$SEMPREC_ROOT/shared/env/api.env"
  local monitor_env="$SEMPREC_ROOT/shared/env/monitor.env"
  local app_base_url domain smtp_host smtp_from
  app_base_url="$(sed -n 's/^APP_BASE_URL=//p' "$env_file" | tail -n 1)"
  domain="$(sed -n 's/^SEMPREC_DOMAIN=//p' "$monitor_env" | tail -n 1)"
  smtp_host="$(sed -n 's/^SMTP_HOST=//p' "$env_file" | tail -n 1)"
  smtp_from="$(sed -n 's/^SMTP_FROM_ADDRESS=//p' "$env_file" | tail -n 1)"

  if [[ -z "$app_base_url" ]]; then
    echo "APP_BASE_URL is not set in $env_file; every emailed link will point at http://localhost:3000 until it is set to https://<SEMPREC_DOMAIN> and semprec-api is restarted" >&2
  elif [[ -n "$domain" && "${app_base_url%/}" != "https://$domain" ]]; then
    echo "APP_BASE_URL is $app_base_url but SEMPREC_DOMAIN is $domain; emailed links expect APP_BASE_URL=https://$domain" >&2
  fi

  if [[ -z "$smtp_host" || -z "$smtp_from" ]]; then
    echo "Outbound mail is not configured: SMTP_HOST and SMTP_FROM_ADDRESS must both be set in $env_file, otherwise password-reset requests answer 200 but no mail is sent" >&2
  fi

  return 0
}

main() {
  require_root
  require_supported_distribution
  install_host_packages
  ensure_service_user
  ensure_release_tree
  install_postgresql_hunspell_assets
  ensure_backup_directory
  install_systemd_units
  install_timer_scripts
  ensure_shared_permissions
  verify_systemd_units
  systemctl daemon-reload
  systemctl restart systemd-journald
  enable_timers
  install_caddy_config
  render_caddy_environment
  check_outbound_link_settings
  install_nftables_config
  apply_nftables
}

main "$@"
