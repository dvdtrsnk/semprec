#!/usr/bin/env bash
# Focused behavior test for the dead-man and restart-exhaustion monitor scripts.
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly TEST_ROOT="$(mktemp -d)"
readonly TEST_BIN="$TEST_ROOT/bin"
readonly CALLS="$TEST_ROOT/calls"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$TEST_BIN"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'printf "%s\\n" "$*" >> "$DEAD_MAN_TEST_CALLS"' \
  'if [[ "${DEAD_MAN_TEST_HEALTH_FAIL:-}" == "1" && "$*" == *"https://semprec.example/healthz"* ]]; then' \
  '  exit 22' \
  'fi' \
  > "$TEST_BIN/curl"
chmod +x "$TEST_BIN/curl"

run_dead_man() {
  PATH="$TEST_BIN:$PATH" \
    DEAD_MAN_TEST_CALLS="$CALLS" \
    SEMPREC_DOMAIN=semprec.example \
    HEALTHCHECKS_PING_URL=https://hc.example/ping \
    "$SCRIPT_DIR/semprec-dead-man.sh"
}

run_dead_man
test "$(wc -l < "$CALLS")" -eq 2
grep -q 'https://semprec.example/healthz' "$CALLS"
grep -q 'https://hc.example/ping' "$CALLS"

: > "$CALLS"
if DEAD_MAN_TEST_HEALTH_FAIL=1 run_dead_man; then
  echo "dead-man script unexpectedly succeeded after a failed health check" >&2
  exit 1
fi
test "$(wc -l < "$CALLS")" -eq 1
grep -q 'https://semprec.example/healthz' "$CALLS"

: > "$CALLS"
PATH="$TEST_BIN:$PATH" \
  DEAD_MAN_TEST_CALLS="$CALLS" \
  HEALTHCHECKS_PING_URL=https://hc.example/ping \
  "$SCRIPT_DIR/semprec-failping.sh" semprec-api.service
grep -q 'https://hc.example/ping/fail' "$CALLS"
grep -q -- '--data-raw semprec-api.service' "$CALLS"

echo 'dead-man monitor script test passed'
