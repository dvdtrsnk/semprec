import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AREAS, classifyPaths, parseArguments } from "./changed-areas.mjs";

const SCRIPT = fileURLToPath(new URL("./changed-areas.mjs", import.meta.url));

function areasOf(path) {
  const byArea = classifyPaths([path]);
  return AREAS.filter((area) => byArea[area].length > 0);
}

const CASES = [
  ["backend/packages/data/src/mail/ingest.ts", ["backend"]],
  ["backend/pnpm-lock.yaml", ["backend"]],
  ["backend/review-rules/rules.md", []],
  ["web/review-rules/tasks/correctness.md", []],
  ["mobile/review-rules/rules.md", []],
  ["mobile/android/review-rules/rules.md", []],
  ["mobile/apple/review-rules/rules.md", []],
  ["deploy/Caddyfile", ["backend"]],
  ["shared/block-model/src/markdown.ts", ["backend"]],
  ["web/src/App.tsx", ["web"]],
  ["mobile/android/app/src/main/kotlin/App.kt", ["android"]],
  ["mobile/apple/Projects/App/Sources/App.swift", ["apple"]],
  ["mobile/shared/presentation/src/commonMain/kotlin/Home.kt", ["android", "apple"]],
  ["mobile/scripts/verify", ["android", "apple"]],
  ["mobile/docs/verify.md", ["android", "apple"]],
  [".prettierignore", ["backend", "web"]],
  [".prettierrc.json", ["backend", "web"]],
  [".github/workflows/ci.yml", [...AREAS]],
  [".github/scripts/changed-areas.mjs", [...AREAS]],
  [".github/scripts/check-write-safety.mjs", ["backend"]],
  [".github/scripts/write-safety-baseline.json", ["backend"]],
  [".github/scripts/issues.mjs", []],
  [".github/scripts/changed-areas.test.mjs", []],
  [".github/ISSUE_FORMAT.md", []],
  [".github/actions/setup/action.yml", [...AREAS]],
  ["docs/architecture/testing.md", []],
  ["issues/items/gh-1.md", []],
  ["review-rules/rules.md", []],
  [".bb/AGENTS.md", []],
  [".claude/settings.json", []],
  [".relay/workflows/implement-issue.md", []],
  ["assets/brand/logo.svg", []],
  ["README.md", []],
  [".gitignore", [...AREAS]],
  ["apple/README.md", [...AREAS]],
  ["tools/new-script.sh", [...AREAS]],
];

for (const [path, expected] of CASES) {
  test(`${path} needs ${expected.length ? expected.join(", ") : "no platform pipeline"}`, () => {
    assert.deepEqual(areasOf(path), expected);
  });
}

test("a README.md below a directory follows that directory", () => {
  assert.deepEqual(areasOf("backend/README.md"), ["backend"]);
  assert.deepEqual(areasOf("docs/README.md"), []);
});

test("paths accumulate per area and an empty change needs nothing", () => {
  assert.deepEqual(classifyPaths([]), { backend: [], web: [], android: [], apple: [] });
  assert.deepEqual(classifyPaths(["web/a.ts", "web/b.ts", "docs/c.md"]), { backend: [], web: ["web/a.ts", "web/b.ts"], android: [], apple: [] });
});

for (const [argv, message] of [
  [["--area", "backend"], /--base is required/],
  [["--base", "main"], /choose exactly one/],
  [["--base", "main", "--area", "ios"], /unknown area "ios"/],
  [["--base", "main", "--area", "web", "--json"], /choose exactly one/],
  [["--base", "--area", "web"], /--base needs a value/],
  [["--base", "main", "--json", "--verbose"], /unknown argument "--verbose"/],
]) {
  test(`usage error: ${argv.join(" ")}`, () => {
    assert.throws(() => parseArguments(argv), message);
  });
}

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args], { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root, path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** main: base commit, then a web change; feature: forked from base, changes only Apple code. */
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "changed-areas-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  write(root, "backend/a.ts", "export const a = 1;\n");
  write(root, "web/b.ts", "export const b = 1;\n");
  write(root, "mobile/apple/App.swift", "let app = 1\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "switch", "-q", "-c", "feature");
  write(root, "mobile/apple/App.swift", "let app = 2\n");
  git(root, "commit", "-q", "-am", "apple change");
  git(root, "switch", "-q", "main");
  write(root, "web/b.ts", "export const b = 2;\n");
  git(root, "commit", "-q", "-am", "web change on main");
  return root;
}

function cli(cwd, args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: { ...GIT_ENV, ...env }, encoding: "utf8" });
}

test("compares from the merge base, so a change on the base branch does not count", (t) => {
  const root = repository(t);
  for (const [area, expected] of [["apple", "true"], ["web", "false"], ["backend", "false"], ["android", "false"]]) {
    const result = cli(root, ["--base", "main", "--head", "feature", "--area", area]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected, area);
    assert.equal(result.stderr, "");
  }
});

test("runs from a subdirectory and defaults --head to HEAD", (t) => {
  const root = repository(t);
  git(root, "switch", "-q", "feature");
  const result = cli(join(root, "backend"), ["--base", "main", "--area", "apple"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "true");
});

test("a file moved from one area to another counts for both", (t) => {
  const root = repository(t);
  git(root, "switch", "-q", "-c", "move", "feature");
  mkdirSync(join(root, "web/moved"), { recursive: true });
  git(root, "mv", "backend/a.ts", "web/moved/a.ts");
  git(root, "commit", "-q", "-m", "move");
  const result = cli(root, ["--base", "feature", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.areas, { backend: true, web: true, android: false, apple: false });
  assert.deepEqual(output.paths.backend, ["backend/a.ts"]);
  assert.deepEqual(output.paths.web, ["web/moved/a.ts"]);
  assert.equal(output.warning, null);
});

test("--github-output appends every area and writes the summary table", (t) => {
  const root = repository(t);
  const outputFile = join(root, "..", `${root.split("/").pop()}-output`);
  const summaryFile = `${outputFile}-summary`;
  t.after(() => rmSync(outputFile, { force: true }));
  t.after(() => rmSync(summaryFile, { force: true }));
  writeFileSync(outputFile, "earlier=1\n");
  const result = cli(root, ["--base", "main", "--head", "feature", "--github-output"], { GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(outputFile, "utf8"), "earlier=1\nbackend=false\nweb=false\nandroid=false\napple=true\n");
  const summary = readFileSync(summaryFile, "utf8");
  assert.match(summary, /\| apple \| yes \| `mobile\/apple\/App\.swift` \|/);
  assert.match(summary, /\| backend \| no \| {2}\|/);
});

test("--github-output without GITHUB_OUTPUT is a usage error", (t) => {
  const root = repository(t);
  const result = cli(root, ["--base", "main", "--head", "feature", "--github-output"], { GITHUB_OUTPUT: "" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--github-output needs GITHUB_OUTPUT/);
  assert.equal(result.stdout, "");
});

test("a comparison git cannot make runs every area and says why", (t) => {
  const root = repository(t);
  const area = cli(root, ["--base", "no-such-revision", "--area", "web"]);
  assert.equal(area.status, 0);
  assert.equal(area.stdout.trim(), "true");
  assert.match(area.stderr, /changed-areas: cannot compare no-such-revision\.\.\.HEAD: .*; treating every area as changed/);
  const json = JSON.parse(cli(root, ["--base", "no-such-revision", "--json"]).stdout);
  assert.deepEqual(json.areas, { backend: true, web: true, android: true, apple: true });
  assert.equal(json.paths, null);
});

test("an unrelated history has no merge base and runs every area", (t) => {
  const root = repository(t);
  git(root, "switch", "-q", "--orphan", "unrelated");
  write(root, "docs/only.md", "x\n");
  git(root, "add", "docs/only.md");
  git(root, "commit", "-q", "-m", "orphan");
  const result = cli(root, ["--base", "main", "--area", "backend"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "true");
  assert.match(result.stderr, /treating every area as changed/);
});

test("usage errors from the command line exit 2 and print no area", (t) => {
  const root = repository(t);
  const result = cli(root, ["--base", "main", "--area", "ios"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unknown area "ios"/);
});
