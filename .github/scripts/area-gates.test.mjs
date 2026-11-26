import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workflowNames = ["implement-issue", "fix-review-findings", "merge-pull-request", "recover-blocked-issue"];
const ci = readFileSync(new URL("../workflows/ci.yml", import.meta.url), "utf8");

function stepScript(name) {
  const match = ci.match(new RegExp(`      - name: ${name}\\n[\\s\\S]*?        run: \\|\\n((?:          .*\\n)+)`));
  assert.ok(match, `ci.yml needs the step "${name}"`);
  return match[1].replace(/^ {10}/gm, "");
}

function job(name) {
  const match = ci.match(new RegExp(`\\n  ${name}:\\n((?:    .*\\n|\\n)+?)(?=  \\S|$)`));
  assert.ok(match, `ci.yml needs the job ${name}`);
  return match[1];
}

const detectionScript = stepScript("Detect the areas this change touches");
const guardScript = stepScript("Area detection succeeded");
const fanInScript = stepScript("Every integration shard succeeded");

const SCRIPTS = ["changed-areas.mjs", "is-entry-script.mjs"].map((name) => fileURLToPath(new URL(`./${name}`, import.meta.url)));

/** A clone of a bare `origin` whose base commit already carries the detector, so no later diff includes it. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "semprec-area-gates-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  const cwd = join(root, "work");
  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
  execFileSync("git", ["clone", remote, cwd], { stdio: "pipe" });
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("config", "user.name", "Area gate test");
  git("config", "user.email", "area-gates@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("checkout", "-b", "develop");
  writeFileSync(join(cwd, "README.md"), "base\n");
  mkdirSync(join(cwd, ".github/scripts"), { recursive: true });
  for (const script of SCRIPTS) copyFileSync(script, join(cwd, ".github/scripts", script.split("/").pop()));
  for (const dir of ["backend", "web"]) {
    mkdirSync(join(cwd, dir), { recursive: true });
    writeFileSync(join(cwd, dir, "package.json"), "{}\n");
  }
  git("add", ".");
  git("commit", "-m", "Base");
  const base = git("rev-parse", "HEAD");
  git("push", "origin", "develop");
  const commit = (path, content = "change\n") => {
    mkdirSync(join(cwd, dirname(path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
    git("add", "--", path);
    git("commit", "-m", `Change ${path}`);
    return git("rev-parse", "HEAD");
  };
  return { root, remote, cwd, git, base, commit };
}

function run(script, cwd, env = {}) {
  return spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout: 20000 });
}

function detect(f, env) {
  const output = join(f.root, "output");
  writeFileSync(output, "");
  const result = run(detectionScript, f.cwd, { GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "", ...env });
  return { ...result, output: readFileSync(output, "utf8") };
}

const areas = (backend, web, android, apple) => `backend=${backend}\nweb=${web}\nandroid=${android}\napple=${apple}\n`;

test("CI detects each area of a pull request against its merge base", (t) => {
  const f = fixture(t);
  const backend = f.commit("backend/file.ts");
  assert.equal(detect(f, { EVENT: "pull_request", PR_BASE: f.base, PR_HEAD: backend }).output, areas(true, false, false, false));
  const mobile = f.commit("mobile/shared/file.kt");
  const result = detect(f, { EVENT: "pull_request", PR_BASE: f.base, PR_HEAD: mobile });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, areas(true, false, true, true));
  f.git("checkout", "-b", "feature", f.base);
  const apple = f.commit("mobile/apple/App.swift");
  assert.equal(detect(f, { EVENT: "pull_request", PR_BASE: mobile, PR_HEAD: apple }).output, areas(false, false, false, true));
});

test("CI detects pushes, including deletion, a move out of an area and an initial push", (t) => {
  const f = fixture(t);
  const added = f.commit("mobile/android/File.kt");
  assert.equal(detect(f, { EVENT: "push", PUSH_BASE: f.base, PUSH_HEAD: added }).output, areas(false, false, true, false));
  const initial = detect(f, { EVENT: "push", PUSH_BASE: "0".repeat(40), PUSH_HEAD: added });
  assert.equal(initial.status, 0, initial.stderr);
  assert.equal(initial.output, areas(true, true, true, true));
  f.git("mv", "mobile/android/File.kt", "web/File.kt");
  f.git("commit", "-m", "Move out of Android");
  const moved = f.git("rev-parse", "HEAD");
  assert.equal(detect(f, { EVENT: "push", PUSH_BASE: added, PUSH_HEAD: moved }).output, areas(false, true, true, false));
  f.git("rm", "-q", "web/File.kt");
  f.git("commit", "-m", "Delete");
  assert.equal(detect(f, { EVENT: "push", PUSH_BASE: moved, PUSH_HEAD: f.git("rev-parse", "HEAD") }).output, areas(false, true, false, false));
});

test("CI runs every area when the comparison cannot be made", (t) => {
  const f = fixture(t);
  const head = f.commit("docs/notes.md");
  assert.equal(detect(f, { EVENT: "push", PUSH_BASE: f.base, PUSH_HEAD: head }).output, areas(false, false, false, false));
  const result = detect(f, { EVENT: "push", PUSH_BASE: "absent", PUSH_HEAD: head });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, areas(true, true, true, true));
  assert.match(result.stderr, /treating every area as changed/);
});

for (const [env, status] of [
  [{ CHANGES_RESULT: "success", BACKEND: "false", WEB: "true", ANDROID: "false", APPLE: "true" }, 0],
  [{ CHANGES_RESULT: "failure", BACKEND: "", WEB: "", ANDROID: "", APPLE: "" }, 1],
  [{ CHANGES_RESULT: "cancelled", BACKEND: "true", WEB: "true", ANDROID: "true", APPLE: "true" }, 1],
  [{ CHANGES_RESULT: "success", BACKEND: "", WEB: "false", ANDROID: "false", APPLE: "false" }, 1],
  [{ CHANGES_RESULT: "success", BACKEND: "false", WEB: "false", ANDROID: "yes", APPLE: "false" }, 1],
]) {
  test(`ci's guard exits ${status} for ${JSON.stringify(env)}`, () => {
    assert.equal(run(guardScript, tmpdir(), env).status, status);
  });
}

for (const [env, status] of [
  [{ EVENT: "pull_request", CHANGES_RESULT: "success", BACKEND: "true", SHARDS_RESULT: "success" }, 0],
  [{ EVENT: "push", CHANGES_RESULT: "success", BACKEND: "false", SHARDS_RESULT: "success" }, 0],
  [{ EVENT: "pull_request", CHANGES_RESULT: "success", BACKEND: "false", SHARDS_RESULT: "skipped" }, 0],
  [{ EVENT: "push", CHANGES_RESULT: "success", BACKEND: "false", SHARDS_RESULT: "skipped" }, 1],
  [{ EVENT: "pull_request", CHANGES_RESULT: "failure", BACKEND: "", SHARDS_RESULT: "skipped" }, 1],
  [{ EVENT: "pull_request", CHANGES_RESULT: "success", BACKEND: "true", SHARDS_RESULT: "skipped" }, 1],
  [{ EVENT: "pull_request", CHANGES_RESULT: "success", BACKEND: "true", SHARDS_RESULT: "failure" }, 1],
  [{ EVENT: "pull_request", CHANGES_RESULT: "success", BACKEND: "false", SHARDS_RESULT: "cancelled" }, 1],
]) {
  test(`integration's fan-in exits ${status} for ${JSON.stringify(env)}`, () => {
    assert.equal(run(fanInScript, tmpdir(), env).status, status);
  });
}

test("every required backend job runs on a push or on a backend change, and ci and integration keep their guards", () => {
  for (const name of ["unit", "integration-shard", "dependency-check", "e2e", "pi-agent-contract"]) {
    const text = job(name);
    assert.match(text, /^    needs: changes\n    if: github\.event_name == 'push' \|\| needs\.changes\.outputs\.backend == 'true'\n/, name);
  }
  assert.match(job("ci"), /^    needs: changes\n    if: \$\{\{ !cancelled\(\) \}\}\n/);
  assert.match(job("ci"), /- name: Area detection succeeded/);
  assert.match(job("integration"), /^    needs: \[changes, integration-shard\]\n    if: \$\{\{ always\(\) \}\}\n/);
  assert.match(job("promotion-source"), /^    runs-on: /);
  assert.match(job("mobile-android"), /^    needs: changes\n    if: needs\.changes\.outputs\.android == 'true'\n/);
  assert.match(job("mobile-apple"), /^    needs: changes\n    if: needs\.changes\.outputs\.apple == 'true'\n/);
  assert.match(job("mobile-apple"), /run: mobile\/scripts\/verify architecture shared apple\n/);
});

/** A `pnpm` on PATH that records its arguments and fails `run verify` when PNPM_VERIFY_STATUS says so. */
function fakePnpm(f) {
  const bin = join(f.root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(f.root, "pnpm.log");
  writeFileSync(join(bin, "pnpm"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$*" = "run verify" ]; then exit "\${PNPM_VERIFY_STATUS:-0}"; fi\n`, { mode: 0o755 });
  return { env: { PATH: `${bin}:${process.env.PATH}` }, calls: () => { try { return readFileSync(log, "utf8"); } catch { return ""; } } };
}

for (const name of workflowNames) {
  const text = readFileSync(new URL(`../../.relay/workflows/${name}.md`, import.meta.url), "utf8");
  const relayStep = (id) => {
    const match = text.match(new RegExp(`  - id: ${id}\\n    uses: command\\n(?:    #.*\\n|    timeout-minutes: .*\\n)*    run: \\|\\n((?:      .*\\n)+)(?:    cwd: (\\w+).*\\n)?    on-failure: \\{ goto: ([\\w-]+), max-rounds: (\\d+) \\}`));
    assert.ok(match, `${name} needs ${id}`);
    return { script: match[1].replace(/^ {6}/gm, ""), cwd: match[2] ?? ".", target: match[3], rounds: match[4] };
  };
  const backendId = name === "implement-issue" ? "verify-backend" : "verify";
  const backend = relayStep(backendId);
  const web = relayStep("verify-web");
  const mobile = relayStep("verify-mobile");
  const target = name === "fix-review-findings" ? "fix-verify" : "fix";

  test(`${name}: ordering, repair routes and mobile instructions`, () => {
    assert.ok(text.indexOf(`id: ${backendId}\n`) < text.indexOf("id: verify-web"));
    assert.ok(text.indexOf("id: verify-web") < text.indexOf("id: verify-mobile"));
    for (const step of [backend, web, mobile]) {
      assert.equal(step.target, target);
      assert.equal(step.rounds, "3");
    }
    assert.equal(backend.cwd, "backend");
    assert.equal(web.cwd, "web");
    assert.match(text, /mobile\/build\/verify\/<run>\//);
    assert.match(text, /timeout-minutes: 120/);
  });

  for (const [area, step] of [["backend", backend], ["web", web]]) {
    test(`${name}: ${area} verify runs only for a ${area} change and propagates its failure`, (t) => {
      const f = fixture(t);
      const pnpm = fakePnpm(f);
      f.commit("mobile/apple/App.swift");
      const skipped = run(step.script, join(f.cwd, step.cwd), pnpm.env);
      assert.equal(skipped.status, 0, skipped.stderr);
      assert.match(skipped.stdout, new RegExp(`No ${area} change found`));
      assert.equal(pnpm.calls(), "");
      f.commit(`${area}/src/file.ts`);
      const ran = run(step.script, join(f.cwd, step.cwd), pnpm.env);
      assert.equal(ran.status, 0, ran.stderr);
      assert.equal(pnpm.calls(), "install --frozen-lockfile\nrun verify\n");
      const failed = run(step.script, join(f.cwd, step.cwd), { ...pnpm.env, PNPM_VERIFY_STATUS: "7" });
      assert.equal(failed.status, 7);
    });

    test(`${name}: ${area} verify compares with the fetched develop, not a stale local one`, (t) => {
      const f = fixture(t);
      const pnpm = fakePnpm(f);
      const remoteHead = f.commit(`${area}/remote.ts`);
      f.git("push", "origin", "HEAD:develop");
      f.git("checkout", "-b", "feature");
      f.git("branch", "-f", "develop", f.base);
      f.git("update-ref", "refs/remotes/origin/develop", f.base);
      f.commit("docs/notes.md");
      const result = run(step.script, join(f.cwd, step.cwd), pnpm.env);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`No ${area} change found`));
      assert.equal(f.git("rev-parse", "origin/develop"), remoteHead);
    });

    test(`${name}: a failed fetch does not become a skipped ${area} verify`, (t) => {
      const f = fixture(t);
      const pnpm = fakePnpm(f);
      f.git("remote", "set-url", "origin", join(f.root, "missing.git"));
      const result = run(step.script, join(f.cwd, step.cwd), pnpm.env);
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /change found/);
      assert.equal(pnpm.calls(), "");
    });
  }

  for (const [path, steps] of [
    ["mobile/shared/Core.kt", "architecture shared android apple"],
    ["mobile/android/App.kt", "architecture android"],
    ["mobile/apple/App.swift", "architecture shared apple"],
  ]) {
    test(`${name}: a change to ${path} runs mobile/scripts/verify ${steps} and propagates its failure`, (t) => {
      const f = fixture(t);
      f.commit(path);
      mkdirSync(join(f.cwd, "mobile/scripts"), { recursive: true });
      const verify = join(f.cwd, "mobile/scripts/verify");
      writeFileSync(verify, '#!/bin/sh\nprintf "%s\\n" "$*"\nexit 23\n', { mode: 0o755 });
      const failed = run(mobile.script, f.cwd);
      assert.equal(failed.status, 23, failed.stderr);
      assert.equal(failed.stdout.trim(), steps);
      writeFileSync(verify, '#!/bin/sh\nprintf "%s\\n" "$*"\n', { mode: 0o755 });
      assert.equal(run(mobile.script, f.cwd).status, 0, "a repaired build must be re-run successfully");
    });
  }

  test(`${name}: no Android or Apple change skips the mobile build`, (t) => {
    const f = fixture(t);
    f.commit("backend/file.ts");
    f.commit("mobile/review-rules/rules.md");
    const result = run(mobile.script, f.cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No Android or Apple change found/);
  });

  test(`${name}: a failed fetch does not become a skipped mobile build`, (t) => {
    const f = fixture(t);
    f.git("remote", "set-url", "origin", join(f.root, "missing.git"));
    const result = run(mobile.script, f.cwd);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /change found/);
  });
}
