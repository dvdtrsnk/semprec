#!/usr/bin/env bash
# Hermetic behavior test for deploy/deploy.sh.
set -euo pipefail

readonly REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly TEST_ROOT="$(mktemp -d)"
readonly TEST_BIN="$TEST_ROOT/bin"
readonly TEST_STATE="$TEST_ROOT/state"
readonly TEST_SEMPREC_ROOT="$TEST_ROOT/opt/semprec"
readonly ORIGIN="$TEST_ROOT/origin.git"
readonly AUTHOR="$TEST_ROOT/author"
readonly OPERATOR="$TEST_ROOT/operator"
export TEST_STATE TEST_SEMPREC_ROOT
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$TEST_BIN" "$TEST_STATE/proc" "$TEST_STATE/pids" "$TEST_SEMPREC_ROOT/releases" "$TEST_SEMPREC_ROOT/shared"
printf 'CREDENTIALS_MASTER_KEY=shared-secret-value\n' > "$TEST_SEMPREC_ROOT/shared/.env"
readonly SHARED_ENV_CHECKSUM="$(sha256sum "$TEST_SEMPREC_ROOT/shared/.env" | awk '{print $1}')"

# ---- Repositories: origin holds main and the tags; the operator checkout runs deploy.sh. ----

git init --quiet --bare --initial-branch=main "$ORIGIN"
git clone --quiet "$ORIGIN" "$AUTHOR" 2>/dev/null
commit_release_content() {
  local marker="$1"
  mkdir -p "$AUTHOR/backend"
  printf '{"name":"semprec","private":true}\n' > "$AUTHOR/backend/package.json"
  printf '%s\n' "$marker" > "$AUTHOR/backend/marker"
  git -C "$AUTHOR" add -A
  git -C "$AUTHOR" commit --quiet -m "$marker"
}
commit_release_content one
git -C "$AUTHOR" tag -a v1.0.0 -m v1.0.0
commit_release_content two
git -C "$AUTHOR" tag -a v1.1.0 -m v1.1.0
git -C "$AUTHOR" tag v1.2.0
git -C "$AUTHOR" push --quiet origin main v1.0.0 v1.1.0 v1.2.0
git -C "$AUTHOR" checkout --quiet -b feature
commit_release_content off-main
git -C "$AUTHOR" tag -a v9.0.0 -m v9.0.0
git -C "$AUTHOR" push --quiet origin feature v9.0.0

git clone --quiet "$ORIGIN" "$OPERATOR"
mkdir -p "$OPERATOR/deploy"
cp "$REPOSITORY_ROOT/deploy/deploy.sh" "$OPERATOR/deploy/deploy.sh"
sed -i "s|readonly SEMPREC_ROOT=/opt/semprec|readonly SEMPREC_ROOT=$TEST_SEMPREC_ROOT|" "$OPERATOR/deploy/deploy.sh"
sed -i "s|readonly PROC_ROOT=/proc|readonly PROC_ROOT=$TEST_STATE/proc|" "$OPERATOR/deploy/deploy.sh"

# ---- Mocks ----

write_mock() {
  local name="$1"
  local body="$2"
  printf '#!/usr/bin/env bash\nset -euo pipefail\n%s\n' "$body" > "$TEST_BIN/$name"
  chmod +x "$TEST_BIN/$name"
}

# Records a violation, checked at the end, when `current` names the release still being prepared.
write_mock assert-not-current '
if [[ -L "$TEST_SEMPREC_ROOT/current" && "$(readlink -f "$TEST_SEMPREC_ROOT/current")" == "$(readlink -f "$1")" ]]; then
  echo "current targets a release that is still being prepared: $1" >> "$TEST_STATE/violations"
fi'
write_mock id 'if [[ "${1:-}" == "-u" ]]; then echo 0; fi'
write_mock pnpm '
assert-not-current "$(dirname "$PWD")"
echo "pnpm $*" >> "$TEST_STATE/commands"
if [[ "$1" == "install" && -f "$TEST_STATE/fail-build" ]]; then exit 1; fi
if [[ "$1" == "-r" ]]; then touch "$PWD/built"; fi'
write_mock systemd-run '
working_directory=""
for arg in "$@"; do
  case "$arg" in
    --working-directory=*) working_directory="${arg#--working-directory=}" ;;
  esac
done
assert-not-current "$(dirname "$working_directory")"
test -f "$working_directory/built"
grep -qx "APP_VERSION=v[0-9.]*" "$(dirname "$working_directory")/release.env"
echo "systemd-run $*" >> "$TEST_STATE/commands"
if [[ -f "$TEST_STATE/fail-migrate" ]]; then exit 1; fi'
# `restart` simulates systemd: the new process gets the shared .env plus current/release.env.
write_mock systemctl '
case "$1" in
  list-units)
    if [[ -f "$TEST_STATE/mailsync-units" ]]; then cat "$TEST_STATE/mailsync-units"; fi
    ;;
  restart)
    echo "systemctl restart $2" >> "$TEST_STATE/commands"
    pid=$(( $(cat "$TEST_STATE/next-pid" 2>/dev/null || echo 100) + 1 ))
    echo "$pid" > "$TEST_STATE/next-pid"
    mkdir -p "$TEST_STATE/proc/$pid"
    cat "$TEST_SEMPREC_ROOT/shared/.env" "$TEST_SEMPREC_ROOT/current/release.env" | tr "\n" "\0" > "$TEST_STATE/proc/$pid/environ"
    echo "$pid" > "$TEST_STATE/pids/$2"
    ;;
  show)
    cat "$TEST_STATE/pids/$4" 2>/dev/null || echo 0
    ;;
  *) exit 1 ;;
esac'

run_deploy() {
  PATH="$TEST_BIN:$PATH" bash "$OPERATOR/deploy/deploy.sh" "$@"
}

expect_refused() {
  local expected_message="$1"
  shift
  if run_deploy "$@" > "$TEST_STATE/refused.out" 2>&1; then
    echo "deploy.sh $* unexpectedly succeeded" >&2
    exit 1
  fi
  grep -q "$expected_message" "$TEST_STATE/refused.out"
}

assert_no_partial_releases() {
  if compgen -G "$TEST_SEMPREC_ROOT/releases/.*.partial.*" > /dev/null; then
    echo "a partial release was left behind" >&2
    exit 1
  fi
}

assert_current() {
  test "$(readlink "$TEST_SEMPREC_ROOT/current")" == "$TEST_SEMPREC_ROOT/releases/$1"
}

# ---- A malformed tag is refused before anything happens. ----

for bad_tag in 1.0.0 v1.0 v01.0.0 v1.0.0-rc.1 main; do
  expect_refused 'invalid release tag' "$bad_tag"
done
test ! -e "$TEST_SEMPREC_ROOT/current"
test ! -e "$TEST_STATE/commands"

# ---- First deploy: every process type restarts and reports the one version. ----

printf 'semprec-mailsync@alice.service loaded active running Semprec mail sync worker for alice\n' \
  > "$TEST_STATE/mailsync-units"
run_deploy v1.0.0 > "$TEST_STATE/deploy.out"
assert_current v1.0.0
grep -qx one "$TEST_SEMPREC_ROOT/releases/v1.0.0/backend/marker"
grep -qx 'APP_VERSION=v1.0.0' "$TEST_SEMPREC_ROOT/releases/v1.0.0/release.env"
for unit in semprec-ai-gateway semprec-api semprec-agents semprec-transcribe semprec-mailsync@alice; do
  grep -qx "systemctl restart $unit.service" "$TEST_STATE/commands"
  grep -qx "$unit.service: v1.0.0" "$TEST_STATE/deploy.out"
done
grep -q 'pnpm install --frozen-lockfile' "$TEST_STATE/commands"
grep -q "EnvironmentFile=$TEST_SEMPREC_ROOT/shared/.env" "$TEST_STATE/commands"
grep -q 'runMigrationsCli.js' "$TEST_STATE/commands"
if grep -q 'shared-secret-value' "$TEST_STATE/deploy.out"; then
  echo 'deploy output exposed a shared secret' >&2
  exit 1
fi
test -z "$(find "$TEST_SEMPREC_ROOT/releases" -name .env)"
assert_no_partial_releases

# ---- Pre-activation failures leave current and the services unchanged. ----

rm "$TEST_STATE/commands"
touch "$TEST_STATE/fail-build"
expect_refused 'build of the staged release failed' v1.1.0
rm "$TEST_STATE/fail-build"
touch "$TEST_STATE/fail-migrate"
expect_refused 'migrations failed' v1.1.0
rm "$TEST_STATE/fail-migrate"
assert_current v1.0.0
test ! -e "$TEST_SEMPREC_ROOT/releases/v1.1.0"
assert_no_partial_releases
if grep -q 'systemctl restart' "$TEST_STATE/commands"; then
  echo 'a failed deploy restarted a service' >&2
  exit 1
fi

# ---- Ineligible tags are refused. ----

expect_refused 'not an annotated release tag' v1.2.0
expect_refused 'not on main' v9.0.0
expect_refused 'cannot fetch tag' v7.7.7
expect_refused 'already exists; releases are immutable' v1.0.0
assert_current v1.0.0
assert_no_partial_releases

# ---- A second deploy swaps current and leaves the previous release intact. ----

rm "$TEST_STATE/mailsync-units"
run_deploy v1.1.0 > "$TEST_STATE/deploy.out"
assert_current v1.1.0
grep -qx two "$TEST_SEMPREC_ROOT/releases/v1.1.0/backend/marker"
grep -qx one "$TEST_SEMPREC_ROOT/releases/v1.0.0/backend/marker"
for unit in semprec-ai-gateway semprec-api semprec-agents semprec-transcribe; do
  grep -qx "$unit.service: v1.1.0" "$TEST_STATE/deploy.out"
done
assert_no_partial_releases

test "$(sha256sum "$TEST_SEMPREC_ROOT/shared/.env" | awk '{print $1}')" == "$SHARED_ENV_CHECKSUM"
test ! -e "$TEST_STATE/violations"

echo 'deploy.sh behavior test passed'
