#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$WORK/bin"
export TEST_ACTIVATION_WORK="$WORK"
export TEST_ACTIVATION_NODE="${TEST_ACTIVATION_NODE:-$(command -v node)}"

# Execute the documentation's marked block itself, once and without changing its commands.
awk '
  /<!-- restore-activation-command:start -->/ { if (found++) exit 1; state = 1; next }
  /<!-- restore-activation-command:end -->/ { if (state != 2) exit 1; state = 3; next }
  state == 1 && /^```bash$/ { state = 2; next }
  state == 2 && /^```$/ { next }
  state == 2 { print }
  END { if (found != 1 || state != 3) exit 1 }
' "$ROOT/deploy/README.md" > "$WORK/activation.sh"

cat > "$WORK/bin/restic" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ ! -e "$TEST_ACTIVATION_WORK/fail-fetch" ]] || exit 31
printf '%s\n' "${TEST_ACTIVATION_LEDGER_ID:-11111111-1111-4111-8111-111111111111}"
MOCK
cat > "$WORK/bin/node" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ -e "$TEST_ACTIVATION_WORK/fail-missing-entry" && "$1" == */replayTenantDeletionsCli.js ]]; then
  exec "$TEST_ACTIVATION_NODE" "$TEST_ACTIVATION_WORK/missing-entry.js"
fi
if [[ -n "${TEST_ACTIVATION_NATIVE_DIR:-}" ]]; then
  entry="${1##*/}"
  shift
  exec "$TEST_ACTIVATION_NODE" "$TEST_ACTIVATION_NATIVE_DIR/$entry" "$@"
fi
case "$1" in
  */validateRestoreLedgerCli.js)
    [[ ! -e "$TEST_ACTIVATION_WORK/fail-validation" ]] || exit 32 ;;
  */replayTenantDeletionsCli.js)
    [[ ! -e "$TEST_ACTIVATION_WORK/fail-replay" ]] || exit 1 ;;
  *) exit 33 ;;
esac
MOCK
cat > "$WORK/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_ACTIVATION_WORK/started"
MOCK
chmod +x "$WORK/bin/restic" "$WORK/bin/node" "$WORK/bin/systemctl"

run_block() {
  PATH="$WORK/bin:$PATH" SEMPREC_API_DATABASE_URL="${TEST_ACTIVATION_DATABASE_URL:-synthetic}" \
    SEMPREC_RESTORE_LEDGER="$WORK/ledger" bash "$WORK/activation.sh"
}
if [[ -n "${TEST_ACTIVATION_NATIVE_DIR:-}" ]]; then
  if run_block; then
    cp "$WORK/started" "$TEST_ACTIVATION_RESULT"
  else
    [[ ! -e "$WORK/started" ]]
    exit 1
  fi
  exit 0
fi
for failure in fail-fetch fail-validation fail-replay fail-missing-entry; do
  touch "$WORK/$failure"
  if run_block; then echo 'activation block unexpectedly succeeded' >&2; exit 1; fi
  [[ ! -e "$WORK/started" ]]
  rm "$WORK/$failure"
done
run_block
[[ "$(cat "$WORK/started")" == 'start semprec-api.service semprec-agents.service semprec-transcribe.service semprec-ai-gateway.service' ]]
echo 'Extracted activation block synthetic control passed'
