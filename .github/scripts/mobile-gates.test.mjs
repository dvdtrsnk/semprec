import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const workflowNames = ["implement-issue", "fix-review-findings", "merge-pull-request", "recover-blocked-issue"];
const ci = readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8");
const detection = ci.match(/      - name: Detect mobile changes[\s\S]*?        run: \|\n((?:          .*\n)+)/)?.[1];
assert.ok(detection, "CI change detector must exist");
const ciScript = detection.replace(/^          /gm, "");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "semprec-mobile-gates-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  const cwd = join(root, "work");
  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
  execFileSync("git", ["clone", remote, cwd], { stdio: "pipe" });
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("config", "user.name", "Mobile gate test");
  git("config", "user.email", "mobile-gates@example.invalid");
  git("checkout", "-b", "develop");
  writeFileSync(join(cwd, "README.md"), "base\n");
  git("add", ".");
  git("commit", "-m", "Base");
  const base = git("rev-parse", "HEAD");
  git("push", "origin", "develop");
  const commit = (path, content = "change\n") => {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), content);
    git("add", ".");
    git("commit", "-m", "Change");
    return git("rev-parse", "HEAD");
  };
  return { root, remote, cwd, git, base, commit };
}

function run(script, f, env = {}) {
  return spawnSync("bash", ["-c", script], {
    cwd: f.cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout: 10000,
  });
}

function detect(f, env) {
  const output = join(f.root, "output");
  writeFileSync(output, "");
  const result = run(ciScript, f, { GITHUB_OUTPUT: output, ...env });
  return { ...result, output: readFileSync(output, "utf8") };
}

test("CI detects a mobile PR and skips a backend-only PR", (t) => {
  const f = fixture(t);
  const backend = f.commit("backend/file.ts");
  assert.equal(detect(f, { EVENT: "pull_request", PR_BASE: f.base, PR_HEAD: backend }).output, "changed=false\n");
  const mobile = f.commit("mobile/file.kt");
  const result = detect(f, { EVENT: "pull_request", PR_BASE: f.base, PR_HEAD: mobile });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "changed=true\n");
});

test("CI compares a PR at its merge base, excluding mobile changes only on the base", (t) => {
  const f = fixture(t);
  const base = f.commit("mobile/base.kt");
  f.git("checkout", "-b", "feature", f.base);
  const head = f.commit("backend/feature.ts");
  const result = detect(f, { EVENT: "pull_request", PR_BASE: base, PR_HEAD: head });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "changed=false\n");
});

test("CI detects mobile pushes, including deletion, rename and initial push", (t) => {
  const f = fixture(t);
  const added = f.commit("mobile/file.kt");
  for (const base of [f.base, "0".repeat(40)]) {
    const result = detect(f, { EVENT: "push", PUSH_BASE: base, PUSH_HEAD: added });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "changed=true\n");
  }
  f.git("mv", "mobile/file.kt", "moved.kt");
  f.git("commit", "-m", "Move out of mobile");
  assert.equal(detect(f, { EVENT: "push", PUSH_BASE: added, PUSH_HEAD: f.git("rev-parse", "HEAD") }).output, "changed=true\n");
  const restored = f.commit("mobile/file.kt");
  f.git("rm", "mobile/file.kt");
  f.git("commit", "-m", "Delete mobile");
  assert.equal(detect(f, { EVENT: "push", PUSH_BASE: restored, PUSH_HEAD: f.git("rev-parse", "HEAD") }).output, "changed=true\n");
});

test("CI skips non-mobile pushes and fails closed on invalid revisions", (t) => {
  const f = fixture(t);
  const head = f.commit("web/file.ts");
  assert.equal(detect(f, { EVENT: "push", PUSH_BASE: f.base, PUSH_HEAD: head }).output, "changed=false\n");
  const result = detect(f, { EVENT: "push", PUSH_BASE: "absent", PUSH_HEAD: head });
  assert.notEqual(result.status, 0);
  assert.equal(result.output, "");
});

for (const name of workflowNames) {
  const text = readFileSync(new URL(`../../.relay/workflows/${name}.md`, import.meta.url), "utf8");
  const step = text.match(/  - id: verify-mobile\n[\s\S]*?    run: \|\n((?:      .*\n)+)    on-failure: \{ goto: ([\w-]+), max-rounds: (\d+) \}/);
  assert.ok(step, `${name} needs verify-mobile`);
  const script = step[1].replace(/^      /gm, "");
  test(`${name}: ordering, repair route and mobile instructions`, () => {
    assert.ok(text.indexOf("id: verify-web") < text.indexOf("id: verify-mobile"));
    const preceding = text.slice(0, text.indexOf("  - id: verify-mobile")).trimEnd();
    assert.match(preceding, /id: verify-web[\s\S]*on-failure: \{ goto: [\w-]+, max-rounds: 3 \}[^\n]*$/);
    assert.equal(step[2], name === "fix-review-findings" ? "fix-verify" : "fix");
    assert.equal(step[3], "3");
    assert.match(text, /mobile\/build\/verify\/<run>\//);
    assert.match(text, /timeout-minutes: 120/);
  });
  test(`${name}: no mobile change skips the build`, (t) => {
    const f = fixture(t);
    f.commit("backend/file.ts");
    const result = run(script, f);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No mobile\/ change found/);
  });
  test(`${name}: fresh remote comparison detects a mobile branch with stale local develop and propagates build failure`, (t) => {
    const f = fixture(t);
    const remoteHead = f.commit("backend/remote.ts");
    f.git("push", "origin", "HEAD:develop");
    f.git("checkout", "-b", "feature");
    f.git("branch", "-f", "develop", f.base);
    f.git("update-ref", "refs/remotes/origin/develop", f.base);
    f.commit("mobile/source.kt");
    mkdirSync(join(f.cwd, "mobile/scripts"), { recursive: true });
    const verify = join(f.cwd, "mobile/scripts/verify");
    writeFileSync(verify, '#!/bin/sh\nprintf "%s\\n" "$*"\nexit 23\n', { mode: 0o755 });
    const result = run(script, f);
    assert.equal(result.status, 23, result.stderr);
    assert.match(result.stdout, /architecture shared android apple/);
    assert.equal(f.git("rev-parse", "origin/develop"), remoteHead);
    assert.equal(f.git("rev-parse", "develop"), f.base);
    writeFileSync(verify, '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o755 });
    assert.equal(run(script, f).status, 0, "a repaired build must be re-run successfully");
  });
  test(`${name}: failed fetch does not become a skipped build`, (t) => {
    const f = fixture(t);
    f.git("remote", "set-url", "origin", join(f.root, "missing.git"));
    const result = run(script, f);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /No mobile\/ change found/);
  });
}
