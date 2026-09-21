#!/usr/bin/env bash
# Provision a Debian or Ubuntu host for the first Semprec deployment.
set -euo pipefail

readonly SEMPREC_ROOT=/opt/semprec
readonly BACKUP_DIRECTORY=/var/backups/semprec
readonly SYSTEMD_UNIT_DIR=/etc/systemd/system
readonly JOURNALD_CONFIG_DIR=/etc/systemd/journald.conf.d
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly APT_KEYRING_DIR=/etc/apt/keyrings
readonly APT_SOURCES_DIR=/etc/apt/sources.list.d
readonly HUNSPELL_BASENAME=cs_CZ
readonly HUNSPELL_DICT_SOURCE=/usr/share/hunspell/cs_CZ.dic
readonly HUNSPELL_AFFIX_SOURCE=/usr/share/hunspell/cs_CZ.aff

readonly -a SERVICE_UNITS=(
  semprec-api.service
  semprec-agents.service
  semprec-mailsync@.service
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
  if ! postgres_container="$(docker compose -f "$SCRIPT_DIR/docker-compose.yml" ps --quiet postgres)" || [[ -z "$postgres_container" ]]; then
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

  if [[ -e "$path" && ! -d "$path" ]]; then
    echo "Expected directory at $path, found another file type" >&2
    exit 1
  fi
  if [[ ! -e "$path" ]]; then
    install -d -o root -g root -m "$mode" "$path"
  fi
}

ensure_release_tree() {
  ensure_directory "$SEMPREC_ROOT" 0755
  ensure_directory "$SEMPREC_ROOT/releases" 0755
  ensure_directory "$SEMPREC_ROOT/shared" 0700
  ensure_directory "$SEMPREC_ROOT/shared/bin" 0750

  local shared_env="$SEMPREC_ROOT/shared/.env"
  if [[ ! -e "$shared_env" && ! -L "$shared_env" ]]; then
    install -o root -g root -m 0600 "$SCRIPT_DIR/shared/.env.example" "$shared_env"
  fi
}

ensure_backup_directory() {
  ensure_directory "$BACKUP_DIRECTORY" 0700
}

install_systemd_units() {
  local unit
  for unit in "${SERVICE_UNITS[@]}" "${TIMER_SERVICES[@]}" "${TIMER_UNITS[@]}"; do
    install -o root -g root -m 0644 "$SCRIPT_DIR/systemd/$unit" "$SYSTEMD_UNIT_DIR/$unit"
  done

  install -d -o root -g root -m 0755 "$JOURNALD_CONFIG_DIR"
  install -o root -g root -m 0644 \
    "$SCRIPT_DIR/systemd/journald-semprec.conf" \
    "$JOURNALD_CONFIG_DIR/semprec.conf"
}

install_timer_scripts() {
  local script
  for script in dead-man backup restore-test trash-purge; do
    install -o root -g root -m 0750 \
      "$SCRIPT_DIR/systemd/scripts/semprec-$script.sh" \
      "$SEMPREC_ROOT/shared/bin/semprec-$script.sh"
  done
}

verify_systemd_units() {
  local -a unit_paths=()
  local unit
  for unit in "${SERVICE_UNITS[@]}" "${TIMER_SERVICES[@]}" "${TIMER_UNITS[@]}"; do
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

main() {
  require_root
  require_supported_distribution
  install_host_packages
  install_postgresql_hunspell_assets
  ensure_service_user
  ensure_release_tree
  ensure_backup_directory
  install_systemd_units
  install_timer_scripts
  verify_systemd_units
  systemctl daemon-reload
  systemctl restart systemd-journald
  enable_timers
}

main "$@"
