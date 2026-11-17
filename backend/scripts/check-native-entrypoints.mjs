#!/usr/bin/env node
// Runs every compiled entry that the deploy scripts, the systemd units and the restore runbook start
// as a plain `node <entry>` and proves that each one loads and reaches its own configuration refusal.
//
// Usage: node scripts/check-native-entrypoints.mjs [--root <backend directory>]
//
// The default root is the parent of this script's directory. Each entry runs with the working
// directory set to the root and an environment of PATH and HOME only, so no NODE_OPTIONS, NODE_PATH,
// loader or secret reaches it. With no configuration every entry refuses before it connects to
// anything or writes anything, which makes the run safe on a staged release. An entry passes when its
// output contains its own refusal and no module-resolution failure; this proves module loading and the
// refusal, not that a service starts (docs/adr/2026-11-15-workspace-root-exports-for-the-service-entrypoints.md).
//
// Prints one line per entry (`ok <path>` or `FAIL <path>: <reason>`) and exits 1 when any entry failed
// or could not be started, otherwise 0. A bad argument exits 2.
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY_TIMEOUT_MS = 30_000;
const OUTPUT_CAP_BYTES = 1_000_000;
const REPORT_CHARS = 500;
const SETTLE_AFTER_KILL_MS = 5_000;

const NOT_SET = /is not set/;

/** The compiled entries, relative to the backend directory, each with the refusal it must end in. */
const ENTRIES = [
  { path: "packages/data/dist/db/runMigrationsCli.js", refusal: NOT_SET },
  { path: "packages/data/dist/db/runSeedCli.js", refusal: NOT_SET },
  { path: "packages/data/dist/db/verifyTenancyCli.js", refusal: NOT_SET },
  { path: "packages/data/dist/tenancy/validateRestoreLedgerCli.js", refusal: /Restore ledger validation failed/ },
  { path: "packages/data/dist/tenancy/restoreTenantKeysCli.js", refusal: /Offline key restore failed/ },
  { path: "packages/data/dist/tenancy/replayTenantDeletionsCli.js", refusal: NOT_SET },
  { path: "packages/data/dist/observability/restoreTestResultCli.js", refusal: NOT_SET },
  { path: "services/semprec-api/dist/serve.js", refusal: NOT_SET },
  { path: "services/semprec-agents/dist/serve.js", refusal: NOT_SET },
  { path: "services/semprec-ai-gateway/dist/serve.js", refusal: NOT_SET },
  { path: "services/semprec-transcribe/dist/serve.js", refusal: NOT_SET },
];

const RESOLUTION_FAILURES = [
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "Cannot find module",
];

/** The first characters of the output on one line, for the report. */
function excerpt(output) {
  return output.slice(0, REPORT_CHARS).replace(/\s+/g, " ").trim();
}

function childEnvironment() {
  const env = {};
  for (const name of ["PATH", "HOME"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Starts one entry and settles with how it ended. The promise resolves only after the child has
 * closed (or never started), so no child outlives its entry's line.
 */
function runEntry(root, entry) {
  return new Promise((settle) => {
    let child;
    try {
      child = spawn(process.execPath, [entry.path], {
        cwd: root,
        env: childEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      settle({ startError: error });
      return;
    }
    let output = "";
    let bytes = 0;
    let stopped;
    let forceSettle;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(forceSettle);
      settle(result);
    };
    const stop = (reason) => {
      if (stopped) return;
      stopped = reason;
      try {
        child.kill("SIGKILL");
      } catch {
        // The close or error event below reports a child that cannot be signalled.
      }
      forceSettle = setTimeout(() => finish({ stopped, unsettled: true, output }), SETTLE_AFTER_KILL_MS);
    };
    const timer = setTimeout(() => stop(`timed out after ${ENTRY_TIMEOUT_MS} ms`), ENTRY_TIMEOUT_MS);
    const collect = (chunk) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_CAP_BYTES) {
        stop(`output exceeded ${OUTPUT_CAP_BYTES} bytes`);
        return;
      }
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      // A spawn failure never closes; any other error leaves the close event to settle the child.
      if (child.pid === undefined) finish({ startError: error });
    });
    child.on("close", () => finish({ stopped, output }));
  });
}

/** Returns the failure reason of one run, or undefined when the entry passed. */
function judge(entry, result) {
  if (result.startError) return `could not be started (${result.startError.code ?? result.startError.name})`;
  if (result.stopped) {
    return `${result.stopped}${result.unsettled ? " and the child did not settle" : ""}: ${excerpt(result.output)}`;
  }
  const failure = RESOLUTION_FAILURES.find((marker) => result.output.includes(marker));
  if (failure) return `module resolution failed (${failure}): ${excerpt(result.output)}`;
  if (!entry.refusal.test(result.output)) return `no refusal matching ${entry.refusal}: ${excerpt(result.output)}`;
  return undefined;
}

function parseRoot(argv) {
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (argv.length === 0) return defaultRoot;
  if (argv.length === 2 && argv[0] === "--root" && argv[1] !== "") return resolve(argv[1]);
  return undefined;
}

async function main() {
  const root = parseRoot(process.argv.slice(2));
  if (root === undefined) {
    console.error("Usage: node scripts/check-native-entrypoints.mjs [--root <backend directory>]");
    process.exitCode = 2;
    return;
  }
  let failed = false;
  for (const entry of ENTRIES) {
    const reason = judge(entry, await runEntry(root, entry));
    if (reason === undefined) {
      console.log(`ok ${entry.path}`);
    } else {
      failed = true;
      console.log(`FAIL ${entry.path}: ${reason}`);
    }
  }
  if (failed) process.exitCode = 1;
}

await main();
