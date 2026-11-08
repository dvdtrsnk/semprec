#!/usr/bin/env node
/**
 * Runs every `node:test` file (`*.test.mjs`) under a directory, recursively, skipping
 * `node_modules`.
 *
 * Usage: `node run-repo-script-tests.mjs [directory]`. The directory defaults to the
 * `.github/scripts` directory this file lives in, resolved from the file's own location, not
 * the working directory — so `backend/`'s `test:repo-scripts` and a run from the repository
 * root collect the same files.
 *
 * ## Why this is not just `node --test '<glob>'`
 *
 * `node --test` given a glob that matches no file exits 0 having run nothing (verified on
 * Node 22). A typo in the pattern or a moved directory would silently turn the tests into
 * decoration while `verify` stays green. This runner collects the files itself and exits 1,
 * naming the directory, when it finds none.
 *
 * Otherwise it runs `node --test` on exactly the collected files as a child process with
 * inherited stdio and exits with the child's exit code — 1 if the child was killed by a
 * signal or could not be started.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_SUFFIX = ".test.mjs";

function collectTestFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") files.push(...collectTestFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) {
      files.push(entryPath);
    }
  }
  return files;
}

const args = process.argv.slice(2);
if (args.length > 1) {
  console.error(`run-repo-script-tests: expected at most one directory argument, got ${args.length}`);
  process.exit(1);
}

const root = path.resolve(args[0] ?? path.dirname(fileURLToPath(import.meta.url)));
if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`run-repo-script-tests: ${root} is not a directory`);
  process.exit(1);
}

const files = collectTestFiles(root).sort();
if (files.length === 0) {
  console.error(`run-repo-script-tests: no *${TEST_SUFFIX} file found under ${root}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (result.error) {
  console.error(`run-repo-script-tests: could not start node --test: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
