#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${SEMPREC_DOMAIN:-}" ]]; then
  echo "SEMPREC_DOMAIN must be configured for the public health check" >&2
  exit 1
fi

if [[ -z "${HEALTHCHECKS_PING_URL:-}" ]]; then
  echo "HEALTHCHECKS_PING_URL must be configured for the external success ping" >&2
  exit 1
fi

# This deliberately probes through Caddy and TLS, rather than reaching the loopback listener:
# the dead-man monitor is meant to catch failures in the whole public request path.
curl --fail --silent --show-error --output /dev/null --connect-timeout 10 --max-time 30 --proto '=https' \
  "https://${SEMPREC_DOMAIN}/healthz"

# Only a healthy public response permits the success ping. The URL is an opaque monitor secret;
# do not print it or include it in an error message.
curl --fail --silent --show-error --output /dev/null --connect-timeout 10 --max-time 30 --proto '=https' \
  "$HEALTHCHECKS_PING_URL"
