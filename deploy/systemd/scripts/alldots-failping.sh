#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${HEALTHCHECKS_PING_URL:-}" ]]; then
  echo "HEALTHCHECKS_PING_URL must be configured for the external failure ping" >&2
  exit 1
fi

if [[ "$#" -ne 1 || -z "$1" ]]; then
  echo "expected the failed systemd unit name" >&2
  exit 1
fi

# Healthchecks accepts an arbitrary request body on the failure endpoint; retain the failed unit
# name there without logging the monitor URL or its opaque identifier.
curl --fail --silent --show-error --output /dev/null --connect-timeout 10 --max-time 30 --proto '=https' \
  --data-raw "$1" "${HEALTHCHECKS_PING_URL%/}/fail"
