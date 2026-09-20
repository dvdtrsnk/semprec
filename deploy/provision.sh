#!/usr/bin/env bash
# Provision a Debian or Ubuntu host for the first Semprec deployment.
set -euo pipefail

readonly SEMPREC_ROOT=/opt/semprec
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly APT_KEYRING_DIR=/etc/apt/keyrings
readonly APT_SOURCES_DIR=/etc/apt/sources.list.d

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
    ffmpeg
  corepack enable pnpm
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

  local shared_env="$SEMPREC_ROOT/shared/.env"
  if [[ ! -e "$shared_env" && ! -L "$shared_env" ]]; then
    install -o root -g root -m 0600 "$SCRIPT_DIR/shared/.env.example" "$shared_env"
  fi
}

main() {
  require_root
  require_supported_distribution
  install_host_packages
  ensure_service_user
  ensure_release_tree
}

main "$@"
