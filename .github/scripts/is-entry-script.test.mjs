import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const scripts = [
  ["backfill-model-tiers.mjs", /Use --manifest/],
  ["review-followups/harvest.mjs", /HARVEST_MIN_PR must be a positive integer/],
  ["review-followups/prepare.mjs", /usage: node prepare.mjs/],
  ["review-followups/validate.mjs", /missing argument --input/],
  ["review-followups/publish.mjs", /usage: node publish.mjs/],
];

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "semprec-entry-script-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, cwd) {
  // Invalid arguments fail before a GitHub client is created; no service credentials reach the test process.
  return spawnSync(process.execPath, args, {
    cwd, env: { PATH: process.env.PATH, HARVEST_MIN_PR: "invalid" }, encoding: "utf8", timeout: 10000,
  });
}

for (const [name, error] of scripts) {
  const script = fileURLToPath(new URL(name, import.meta.url));
  test(`${name}: direct, file-symlink and directory-symlink invocations run argument validation`, (t) => {
    const dir = scratch(t);
    symlinkSync(script, join(dir, "entry.mjs"));
    symlinkSync(fileURLToPath(new URL(".", import.meta.url)), join(dir, "scripts"), "dir");
    for (const entry of [script, join(dir, "entry.mjs"), join(dir, "scripts", name)]) {
      const result = run([entry], dir);
      assert.equal(result.status, 1, `${entry}: ${result.stderr}`);
      assert.match(result.stderr, error);
    }
  });
  test(`${name}: importing never invokes the CLI`, (t) => {
    const result = run(["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(script).href)})`], scratch(t));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
}

test("an entry argument that names no file does not turn an import into a CLI invocation", (t) => {
  const helper = new URL("./is-entry-script.mjs", import.meta.url).href;
  const result = run(["--input-type=module", "-e", `
    const { isEntryScript } = await import(${JSON.stringify(helper)});
    if (isEntryScript(${JSON.stringify(helper)})) process.exitCode = 23;
  `, resolve(scratch(t), "missing.mjs")], tmpdir());
  assert.equal(result.status, 0, result.stderr);
});
