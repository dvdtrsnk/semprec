#!/usr/bin/env bash
# Hermetic test for deploy/bin/semprec-mcp-launch: `id` is mocked, the sandbox home is a temporary
# directory, and each case pipes a header (plus any server bytes) into the launcher's stdin.
set -euo pipefail

readonly SOURCE_LAUNCHER="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/semprec-mcp-launch"
readonly TEST_ROOT="$(mktemp -d)"
readonly TEST_BIN="$TEST_ROOT/bin"
readonly TEST_HOME="$TEST_ROOT/home"
readonly LAUNCHER="$TEST_ROOT/semprec-mcp-launch"
readonly MARKER_COMMAND="$TEST_ROOT/marker"
readonly MARKER_FILE="$TEST_ROOT/marker-ran"
readonly SECRET='secret-sentinel-9c2e'

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$TEST_BIN" "$TEST_HOME"
sed "s|^readonly SANDBOX_HOME=/var/lib/semprec-mcp\$|readonly SANDBOX_HOME=$TEST_HOME|" "$SOURCE_LAUNCHER" > "$LAUNCHER"
grep -qx "readonly SANDBOX_HOME=$TEST_HOME" "$LAUNCHER"

# shellcheck disable=SC2016 # the mock's own script text, expanded when it runs
printf '#!/usr/bin/env bash\nif [[ "${1:-}" == "-un" ]]; then cat "%s/uid"; fi\n' "$TEST_ROOT" > "$TEST_BIN/id"
chmod +x "$TEST_BIN/id"
# The command the refusal cases name: if it ever runs, the marker file appears.
printf '#!/bin/sh\n: > %s\n' "$MARKER_FILE" > "$MARKER_COMMAND"
chmod +x "$MARKER_COMMAND"

fail() {
  echo "semprec-mcp-launch.test.sh: $*" >&2
  exit 1
}

# run_launcher <uid> <input file>; leaves stdout in $TEST_ROOT/out, stderr in $TEST_ROOT/err and the
# exit status in $status.
run_launcher() {
  printf '%s\n' "$1" > "$TEST_ROOT/uid"
  rm -f "$MARKER_FILE"
  status=0
  PATH="$TEST_BIN:$PATH" bash "$LAUNCHER" < "$2" > "$TEST_ROOT/out" 2> "$TEST_ROOT/err" || status=$?
}

# header <command> <env JSON object> [args...] prints one compact JSON header line.
header() {
  local command="$1"
  local env="$2"
  shift 2
  # One `--arg` per value: jq would read a positional `--help` as its own option.
  local args='[]'
  local arg
  for arg in "$@"; do
    args="$(jq -c --arg arg "$arg" '. + [$arg]' <<<"$args")"
  done
  jq -cn --arg command "$command" --argjson env "$env" --argjson args "$args" '{command: $command, args: $args, env: $env}'
}

# ---- Exec: exactly the base environment overlaid by the header's env. ----
header env '{"EXTRA_SETTING": "two words", "LANG": "en_US.UTF-8"}' -0 > "$TEST_ROOT/in"
run_launcher semprec-mcp "$TEST_ROOT/in"
(( status == 0 )) || fail "env case exited $status: $(cat "$TEST_ROOT/err")"
actual_env="$(tr '\0' '\n' < "$TEST_ROOT/out" | sort)"
expected_env="$(printf '%s\n' \
  "EXTRA_SETTING=two words" \
  "HOME=$TEST_HOME" \
  "LANG=en_US.UTF-8" \
  "LOGNAME=semprec-mcp" \
  "PATH=/usr/local/bin:/usr/bin:/bin" \
  "USER=semprec-mcp" | sort)"
[[ "$actual_env" == "$expected_env" ]] || fail "unexpected environment: $actual_env"

# ---- Exec: args with spaces, quotes and newlines arrive as separate argv entries, unchanged. ----
# shellcheck disable=SC2016 # `$HOME *` is a literal argument that must not be expanded
readonly -a TRICKY_ARGS=('a b' "it's \"quoted\"" '' '$HOME *' '--help' $'line\nbreak' '=')
header printf '{}' '%s\0' "${TRICKY_ARGS[@]}" > "$TEST_ROOT/in"
run_launcher semprec-mcp "$TEST_ROOT/in"
(( status == 0 )) || fail "args case exited $status"
printf '%s\0' "${TRICKY_ARGS[@]}" > "$TEST_ROOT/expected-args"
cmp -s "$TEST_ROOT/expected-args" "$TEST_ROOT/out" || fail 'args were not passed unchanged'

# ---- Exec: working directory is the sandbox home. ----
header pwd '{}' > "$TEST_ROOT/in"
run_launcher semprec-mcp "$TEST_ROOT/in"
(( status == 0 )) || fail "pwd case exited $status"
[[ "$(cat "$TEST_ROOT/out")" == "$TEST_HOME" ]] || fail "unexpected working directory: $(cat "$TEST_ROOT/out")"

# ---- Exec: the bytes after the header reach the server's stdin byte-for-byte. ----
{
  printf '\0\r\n\n'
  head -c 8192 /dev/urandom
  printf '{"jsonrpc":"2.0"}\n'
} > "$TEST_ROOT/payload"
{
  header cat '{}'
  cat "$TEST_ROOT/payload"
} > "$TEST_ROOT/in"
run_launcher semprec-mcp "$TEST_ROOT/in"
(( status == 0 )) || fail "stdin case exited $status"
cmp -s "$TEST_ROOT/payload" "$TEST_ROOT/out" || fail 'stdin bytes after the header were changed'

# ---- A header of exactly the maximum size is accepted. ----
short_header="$(header "$MARKER_COMMAND" '{"PAD": ""}')"
padding="$(head -c "$((65536 - ${#short_header}))" /dev/zero | tr '\0' x)"
header "$MARKER_COMMAND" "{\"PAD\": \"$padding\"}" > "$TEST_ROOT/in"
test "$(head -n 1 "$TEST_ROOT/in" | tr -d '\n' | wc -c)" -eq 65536
run_launcher semprec-mcp "$TEST_ROOT/in"
(( status == 0 )) || fail "maximum-size header exited $status"
test -e "$MARKER_FILE" || fail 'maximum-size header did not run its command'

# ---- Refusals: exit 64, nothing runs, and stderr carries none of the header's values. ----
assert_refused() {
  local label="$1"
  local uid="$2"
  local input="$3"
  run_launcher "$uid" "$input"
  (( status == 64 )) || fail "$label: expected exit 64, got $status"
  test ! -e "$MARKER_FILE" || fail "$label: the command ran"
  test ! -s "$TEST_ROOT/out" || fail "$label: wrote to stdout"
  if grep -aqF -- "$SECRET" "$TEST_ROOT/err"; then
    fail "$label: stderr contains a header value"
  fi
  grep -q '^semprec-mcp-launch: refused: ' "$TEST_ROOT/err" || fail "$label: no refusal message"
}

# refuse_header <label> <header text, written followed by a newline>
refuse_header() {
  printf '%s\n' "$2" > "$TEST_ROOT/in"
  assert_refused "$1" semprec-mcp "$TEST_ROOT/in"
}

header "$MARKER_COMMAND" "{\"TOKEN\": \"$SECRET\"}" > "$TEST_ROOT/in"
assert_refused 'wrong uid' semprec "$TEST_ROOT/in"
assert_refused 'root uid' root "$TEST_ROOT/in"

refuse_header 'non-JSON' "not json $SECRET"
refuse_header 'two JSON values' "$(header "$MARKER_COMMAND" '{}') {\"x\": \"$SECRET\"}"
refuse_header 'extra field' "{\"command\": \"$MARKER_COMMAND\", \"args\": [], \"env\": {}, \"extra\": \"$SECRET\"}"
refuse_header 'missing field' "{\"command\": \"$MARKER_COMMAND\", \"args\": [\"$SECRET\"]}"
refuse_header 'not an object' "[\"$MARKER_COMMAND\", \"$SECRET\"]"
refuse_header 'empty command' "{\"command\": \"\", \"args\": [\"$SECRET\"], \"env\": {}}"
refuse_header 'non-string command' "{\"command\": 1, \"args\": [\"$SECRET\"], \"env\": {}}"
refuse_header 'non-string arg' "{\"command\": \"$MARKER_COMMAND\", \"args\": [\"$SECRET\", 1], \"env\": {}}"
refuse_header 'non-string env value' "{\"command\": \"$MARKER_COMMAND\", \"args\": [\"$SECRET\"], \"env\": {\"A\": 1}}"
refuse_header 'NUL in command' "{\"command\": \"$MARKER_COMMAND\\u0000$SECRET\", \"args\": [], \"env\": {}}"
refuse_header 'NUL in an arg' "{\"command\": \"$MARKER_COMMAND\", \"args\": [\"a\\u0000$SECRET\"], \"env\": {}}"
refuse_header 'NUL in an env value' "{\"command\": \"$MARKER_COMMAND\", \"args\": [], \"env\": {\"A\": \"\\u0000$SECRET\"}}"
refuse_header 'invalid env name' "{\"command\": \"$MARKER_COMMAND\", \"args\": [], \"env\": {\"1BAD\": \"$SECRET\"}}"
refuse_header 'env name with a dash' "{\"command\": \"$MARKER_COMMAND\", \"args\": [], \"env\": {\"A-B\": \"$SECRET\"}}"
refuse_header 'env name with a trailing newline' "{\"command\": \"$MARKER_COMMAND\", \"args\": [], \"env\": {\"A\\n\": \"$SECRET\"}}"
refuse_header 'env name with a NUL' "{\"command\": \"$MARKER_COMMAND\", \"args\": [], \"env\": {\"A\\u0000\": \"$SECRET\"}}"
refuse_header '= in command' "{\"command\": \"TOKEN=$SECRET\", \"args\": [], \"env\": {}}"
refuse_header 'empty header line' ''

# A raw NUL byte in the header line, which `read` would otherwise drop silently.
{
  printf '{"command": "%s", "args": ["%s' "$MARKER_COMMAND" "$SECRET"
  printf '\0'
  printf '"], "env": {}}\n'
} > "$TEST_ROOT/in"
assert_refused 'raw NUL byte' semprec-mcp "$TEST_ROOT/in"

header "$MARKER_COMMAND" "{\"TOKEN\": \"$SECRET\"}" | tr -d '\n' > "$TEST_ROOT/in"
assert_refused 'no newline' semprec-mcp "$TEST_ROOT/in"

: > "$TEST_ROOT/in"
assert_refused 'empty input' semprec-mcp "$TEST_ROOT/in"

oversized_padding="$(head -c 65536 /dev/zero | tr '\0' x)"
header "$MARKER_COMMAND" "{\"TOKEN\": \"$SECRET$oversized_padding\"}" > "$TEST_ROOT/in"
assert_refused 'more than 65536 bytes' semprec-mcp "$TEST_ROOT/in"

# One byte over the maximum, with the newline right after it.
header "$MARKER_COMMAND" "{\"PAD\": \"${padding}x\"}" > "$TEST_ROOT/in"
test "$(head -n 1 "$TEST_ROOT/in" | tr -d '\n' | wc -c)" -eq 65537
assert_refused '65537 bytes' semprec-mcp "$TEST_ROOT/in"

echo 'semprec-mcp-launch test passed'
