import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-repo-script-tests.mjs");

const PASSING = `import { it } from "node:test";\nit("passes", () => {});\n`;
const FAILING = `import { it } from "node:test";\nit("fails", () => { throw new Error("boom"); });\n`;

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Creates a temporary directory holding `files` (relative path → contents). */
function fixture(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "run-repo-script-tests-"));
  tempDirs.push(dir);
  for (const [relative, contents] of Object.entries(files)) {
    const filePath = path.join(dir, relative);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, contents);
  }
  return dir;
}

function runRunner(args) {
  // Under `node --test` this process carries NODE_TEST_CONTEXT, which would make the nested
  // `node --test` report to this runner instead of exiting with its own status.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [RUNNER, ...args], { encoding: "utf8", env });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("run-repo-script-tests", () => {
  it("exits 1 and names the directory when no test file exists", () => {
    const dir = fixture({ "README.md": "no tests here\n" });
    const { status, output } = runRunner([dir]);
    assert.equal(status, 1);
    assert.match(output, /no \*\.test\.mjs file found/);
    assert.ok(output.includes(dir), `output should name ${dir}: ${output}`);
  });

  it("exits 0 when a single passing test file sits in a nested subdirectory", () => {
    const dir = fixture({ "nested/deeper/ok.test.mjs": PASSING });
    const { status, output } = runRunner([dir]);
    assert.equal(status, 0, output);
    assert.match(output, /pass 1/);
  });

  it("exits non-zero when one of the test files fails", () => {
    const dir = fixture({ "ok.test.mjs": PASSING, "sub/bad.test.mjs": FAILING });
    const { status, output } = runRunner([dir]);
    assert.notEqual(status, 0);
    assert.match(output, /pass 1/);
    assert.match(output, /fail 1/);
  });

  it("does not collect *.test.js, plain *.mjs, or files under node_modules", () => {
    const dir = fixture({
      "ok.test.mjs": PASSING,
      "x.test.js": FAILING,
      "x.mjs": FAILING,
      "node_modules/pkg/y.test.mjs": FAILING,
    });
    const { status, output } = runRunner([dir]);
    assert.equal(status, 0, output);
    assert.match(output, /pass 1/);
    assert.match(output, /fail 0/);
  });

  it("exits 1 when only excluded files exist", () => {
    const dir = fixture({
      "x.test.js": PASSING,
      "x.mjs": PASSING,
      "node_modules/pkg/y.test.mjs": PASSING,
    });
    const { status, output } = runRunner([dir]);
    assert.equal(status, 1);
    assert.match(output, /no \*\.test\.mjs file found/);
  });

  it("exits 1 when the argument is not a directory", () => {
    const dir = fixture({ "file.txt": "" });
    const missing = path.join(dir, "missing");
    const { status, output } = runRunner([missing]);
    assert.equal(status, 1);
    assert.ok(output.includes(`${missing} is not a directory`), output);
    assert.equal(runRunner([path.join(dir, "file.txt")]).status, 1);
  });

  it("exits 1 when given more than one argument", () => {
    const dir = fixture({ "ok.test.mjs": PASSING });
    const { status, output } = runRunner([dir, dir]);
    assert.equal(status, 1);
    assert.match(output, /at most one directory argument, got 2/);
  });
});
