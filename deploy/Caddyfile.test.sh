#!/usr/bin/env bash
# Hermetic behaviour test for the access-log filter in deploy/Caddyfile: neither the query
# string nor the Referer header of a request may reach the log.
set -euo pipefail

readonly REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v caddy >/dev/null 2>&1; then
  echo "caddy is not on PATH; install it to run deploy/Caddyfile.test.sh" >&2
  exit 1
fi

readonly TEST_ROOT="$(mktemp -d)"
readonly LOG_FILE="$TEST_ROOT/caddy.log"
CADDY_PID=""

cleanup() {
  if [[ -n "$CADDY_PID" ]]; then
    kill "$CADDY_PID" 2>/dev/null || true
    wait "$CADDY_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

free_port() {
  python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

{
  printf '{\n\tadmin off\n}\n'
  cat "$REPOSITORY_ROOT/deploy/Caddyfile"
} > "$TEST_ROOT/Caddyfile"

readonly PORT="$(free_port)"
readonly SUFFIX="$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
readonly QUERY_SECRET="QUERY-SECRET-$SUFFIX"
readonly REFERER_SECRET="REFERER-SECRET-$SUFFIX"

SEMPREC_DOMAIN="http://127.0.0.1:$PORT" caddy run --config "$TEST_ROOT/Caddyfile" \
  --adapter caddyfile 2> "$LOG_FILE" &
CADDY_PID=$!

ready=0
for _ in $(seq 1 100); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
    ready=1
    break
  fi
  sleep 0.1
done
if [[ "$ready" -ne 1 ]]; then
  echo "caddy did not answer on port $PORT within 10s" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

curl -s -o /dev/null \
  -H "Referer: http://127.0.0.1:$PORT/?page=setup&token=$REFERER_SECRET" \
  "http://127.0.0.1:$PORT/reset-password?token=$QUERY_SECRET"

kill "$CADDY_PID"
wait "$CADDY_PID" 2>/dev/null || true
CADDY_PID=""

if ! grep -F '"method":"GET"' "$LOG_FILE" | grep -F '"uri":"/reset-password"' \
  | grep -q '"status"'; then
  echo "FAIL: no access entry with method GET, uri /reset-password and a status" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

for secret in "$QUERY_SECRET" "$REFERER_SECRET"; do
  if grep -qF "$secret" "$LOG_FILE"; then
    echo "FAIL: $secret reached the access log" >&2
    exit 1
  fi
done

echo "PASS: access log keeps method, path and status, and holds no query string or Referer"
