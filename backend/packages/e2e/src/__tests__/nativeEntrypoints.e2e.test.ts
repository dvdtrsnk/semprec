import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DRIFT_CHECK_ACTION_ID } from "@semprec/data";

/**
 * The compiled entries of the units, the scripts and the restore runbook, run as plain
 * `process.execPath <compiled file>` children: never a test resolver, a TypeScript loader, `NODE_OPTIONS`,
 * `--conditions` or `--import`. Workspace roots resolve to `dist` through their package manifests
 * (docs/architecture/edges-io-and-errors.md#service-entrypoints-and-packaging), which no source-level test can show.
 *
 * Case (d) starts the API with the other three services, and cases (d) and (e) run under strict tenant scope: the test
 * process has `SEMPREC_TENANT_SCOPE=warn` from `vitest.e2e.config.ts`, so each child's environment is built from a
 * list of names and never carries the variable.
 */

const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const repository = resolve(backend, "..");
const checker = join(backend, "scripts/check-native-entrypoints.mjs");

/** Workspace roots that the compiled entries reach (twelve), as `<dist root>` relative to the backend directory. */
const WORKSPACE_ROOTS = [
  "packages/shared",
  "packages/queue",
  "packages/module-registry",
  "../shared/block-model",
  "packages/data",
  "packages/realtime",
  "packages/application",
  "packages/notifications",
  "packages/ai-gateway-client",
  "packages/ai-gateway",
  "packages/agent-runtime",
  "packages/credentials",
];

const OUTPUT_CAP_BYTES = 2_000_000;
const REPORT_CHARS = 2_000;
const CHECKER_DEADLINE_MS = 120_000;
const CHECKER_SLOW_DEADLINE_MS = 90_000;
const FAST_CHECKER_DEADLINE_MS = 60_000;
const SETUP_CLI_DEADLINE_MS = 90_000;
const START_WAIT_MS = 30_000;
const SHUTDOWN_WAIT_MS = 20_000;
const DROP_DEADLINE_MS = 60_000;
const HEALTHZ_LIMIT_MS = 5_000;
/** Slack for the statements and file work of a case that no timer of its own bounds. */
const CASE_SLACK_MS = 30_000;

const DOWNSTREAM_CASE_TIMEOUT_MS =
  2 * SETUP_CLI_DEADLINE_MS + START_WAIT_MS + HEALTHZ_LIMIT_MS + SHUTDOWN_WAIT_MS + DROP_DEADLINE_MS + CASE_SLACK_MS;
/** Migrate, seed, migrate again and verify the tenancy, each a child of its own, then the drop. */
const DEPLOY_ORDER_CASE_TIMEOUT_MS = 4 * SETUP_CLI_DEADLINE_MS + DROP_DEADLINE_MS + CASE_SLACK_MS;

// Child processes

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Why the harness stopped the child (deadline, output cap, spawn failure), when it did. */
  failure: string | undefined;
  output: string;
}

interface OwnedChild {
  readonly process: ChildProcess;
  readonly output: () => string;
  readonly exited: () => boolean;
  readonly result: Promise<ChildResult>;
}

/** Every child this file started and that has not closed yet; `afterEach` fails a case that leaves one. */
const liveChildren = new Set<ChildProcess>();

/**
 * Starts `node <args>` in the backend directory with exactly `env`. The child is killed with SIGKILL when its
 * deadline expires or its output exceeds the cap, and `result` settles only after the child closed.
 */
function startNode(args: readonly string[], env: Readonly<Record<string, string>>, deadlineMs: number): OwnedChild {
  const child = spawn(process.execPath, [...args], { cwd: backend, env, stdio: ["ignore", "pipe", "pipe"] });
  liveChildren.add(child);
  let text = "";
  let bytes = 0;
  let failure: string | undefined;
  let closed = false;
  const stop = (reason: string): void => {
    failure ??= reason;
    try {
      child.kill("SIGKILL");
    } catch (error) {
      failure += ` (and the child could not be signalled: ${error instanceof Error ? error.name : "unknown"})`;
    }
  };
  const timer = setTimeout(() => stop(`exceeded its ${deadlineMs} ms deadline`), deadlineMs);
  const collect = (chunk: Buffer): void => {
    bytes += chunk.length;
    if (bytes > OUTPUT_CAP_BYTES) {
      stop(`output exceeded ${OUTPUT_CAP_BYTES} bytes`);
      return;
    }
    text += chunk.toString("utf8");
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const result = new Promise<ChildResult>((settle) => {
    const done = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      liveChildren.delete(child);
      settle({ code, signal, failure, output: text });
    };
    child.on("error", (error) => {
      failure ??= `child error ${error.name}`;
      // A spawn failure never closes; any other error leaves the close event to settle the child.
      if (child.pid === undefined) done(null, null);
    });
    child.on("close", done);
  });
  return { process: child, output: () => text, exited: () => closed, result };
}

function excerpt(text: string): string {
  return text.length > REPORT_CHARS ? `${text.slice(0, REPORT_CHARS)}...` : text;
}

/** Runs a child to its end and returns its result; the caller asserts on it. */
async function runNode(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  deadlineMs: number,
): Promise<ChildResult> {
  return startNode(args, env, deadlineMs).result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Polls the child's output until `pattern` appears, the child exits or `limitMs` passes. */
async function waitForOutput(run: OwnedChild, pattern: RegExp, limitMs: number): Promise<boolean> {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    if (pattern.test(run.output())) return true;
    if (run.exited()) return false;
    await sleep(50);
  }
  return pattern.test(run.output());
}

/** SIGTERM, then at most `limitMs` for the exit; a child that does not exit is killed and reported. */
async function terminate(run: OwnedChild, limitMs: number): Promise<{ result: ChildResult; exitedInTime: boolean }> {
  run.process.kill("SIGTERM");
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<undefined>((done) => {
    timer = setTimeout(() => done(undefined), limitMs);
  });
  const first = await Promise.race([run.result, expired]);
  clearTimeout(timer);
  if (first) return { result: first, exitedInTime: true };
  run.process.kill("SIGKILL");
  return { result: await run.result, exitedInTime: false };
}

/** The environment of a child that is given only the names it needs; never a spread of `process.env`. */
function explicitEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

afterEach(async () => {
  const leftovers = [...liveChildren];
  for (const child of leftovers) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The failure below names the leak; a child that cannot be signalled is reported there as well.
    }
  }
  await Promise.all(
    leftovers.map(
      (child) =>
        new Promise<void>((done) => {
          if (child.exitCode !== null || child.signalCode !== null) done();
          else child.once("close", () => done());
        }),
    ),
  );
  expect(leftovers.map((child) => child.pid)).toEqual([]);
});

// Build provenance

/** `dist/x.js` of a source entry `src/x.ts`. */
function sourceOf(compiled: string): string {
  return compiled.replace("/dist/", "/src/").replace(/\.js$/, ".ts");
}

/** Throws unless every compiled file this file runs exists and is not older than its source. */
function assertBuilt(entries: readonly string[]): void {
  const pairs = [
    ...entries.map((entry) => ({ compiled: join(backend, entry), source: join(backend, sourceOf(entry)) })),
    ...WORKSPACE_ROOTS.map((root) => ({
      compiled: join(backend, root, "dist/index.js"),
      source: join(backend, root, "src/index.ts"),
    })),
  ];
  for (const { compiled, source } of pairs) {
    let compiledTime: number;
    try {
      compiledTime = statSync(compiled).mtimeMs;
    } catch {
      throw new Error(`Build backend artifacts before this test: ${compiled} is missing`);
    }
    if (compiledTime < statSync(source).mtimeMs)
      throw new Error(`Build backend artifacts before this test: ${compiled}`);
  }
}

// The checker and its table

interface CheckerLine {
  status: "ok" | "FAIL";
  path: string;
  reason: string;
}

/** Parses the one-line-per-entry report of the checker. */
function parseReport(output: string): CheckerLine[] {
  const lines: CheckerLine[] = [];
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const match = /^(ok|FAIL) (\S+?)(?:: (.*))?$/.exec(line);
    if (!match?.[1] || !match[2]) throw new Error(`Unexpected checker line: ${excerpt(line)}`);
    lines.push({ status: match[1] === "ok" ? "ok" : "FAIL", path: match[2], reason: match[3] ?? "" });
  }
  return lines;
}

function runChecker(args: readonly string[], deadlineMs: number, extraEnv: Readonly<Record<string, string>> = {}) {
  return runNode([checker, ...args], explicitEnv(extraEnv), deadlineMs);
}

/** The checker's table, read the way an operator reads it: the entries it names when pointed at an empty root. */
async function readCheckerTable(): Promise<string[]> {
  const emptyRoot = mkdtempSync(join(tmpdir(), "semprec-native-empty-"));
  try {
    const run = await runChecker(["--root", emptyRoot], FAST_CHECKER_DEADLINE_MS);
    expect(run.failure).toBeUndefined();
    return parseReport(run.output).map((line) => line.path);
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
}

/** Every compiled `dist/...js` path under `backend/` that `text` names, relative to the backend directory. */
function namedDistPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b((?:packages|services)\/[A-Za-z0-9-]+\/dist\/[A-Za-z0-9_./-]+\.js)\b/g)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

/** The files whose compiled entry paths the table must cover: deploy.sh, the units, the timer scripts and the README. */
function deployFiles(): { name: string; text: string }[] {
  const deploy = join(repository, "deploy");
  const names = ["deploy.sh", "README.md"];
  for (const [directory, suffix] of [
    ["systemd", ".service"],
    ["systemd/scripts", ".sh"],
  ] as const) {
    for (const entry of readdirSync(join(deploy, directory))) {
      const file = join(deploy, directory, entry);
      if (entry.endsWith(suffix) && lstatSync(file).isFile()) names.push(`${directory}/${entry}`);
    }
  }
  return names.map((name) => ({ name, text: readFileSync(join(deploy, name), "utf8") }));
}

/** The paths a deploy file names that the table lacks, and the table entries that no file names. */
function coverageGaps(table: readonly string[], files: readonly { name: string; text: string }[]) {
  const named = new Map<string, string>();
  for (const file of files) for (const path of namedDistPaths(file.text)) named.set(path, file.name);
  return {
    unlisted: [...named].filter(([path]) => !table.includes(path)).map(([path, file]) => `${path} (named by ${file})`),
    unnamed: table.filter((path) => !named.has(path)),
  };
}

describe("native entrypoints: the table and the checker", () => {
  let table: string[];

  beforeAll(async () => {
    table = await readCheckerTable();
    assertBuilt(table);
  }, FAST_CHECKER_DEADLINE_MS + 30_000);

  it("(a) the table holds exactly the compiled entries that deploy.sh, the units, the scripts and the README name", () => {
    expect(table).toHaveLength(11);
    const files = deployFiles();
    expect(files.map((file) => file.name)).toEqual(
      expect.arrayContaining(["deploy.sh", "README.md", "systemd/semprec-api.service"]),
    );
    expect(coverageGaps(table, files)).toEqual({ unlisted: [], unnamed: [] });
  }, 30_000);

  it("(a) a named entry that the table lacks, or a table entry that nothing names, is reported", () => {
    const gaps = coverageGaps(table, [
      {
        name: "semprec-new.service",
        text: "ExecStart=/usr/bin/env node /opt/semprec/current/backend/services/semprec-new/dist/serve.js",
      },
      { name: "deploy.sh", text: "node packages/data/dist/db/runSeedCli.js" },
    ]);
    expect(gaps.unlisted).toEqual(["services/semprec-new/dist/serve.js (named by semprec-new.service)"]);
    expect(gaps.unnamed).toEqual(table.filter((path) => path !== "packages/data/dist/db/runSeedCli.js"));
  }, 30_000);

  it(
    "(b) the real checker exits 0 and prints ok for all eleven compiled entries",
    async () => {
      const run = await runChecker([], CHECKER_DEADLINE_MS);
      expect(run.failure).toBeUndefined();
      const report = parseReport(run.output);
      expect(report.filter((line) => line.status === "FAIL")).toEqual([]);
      expect(report.map((line) => line.path)).toEqual(table);
      expect(report.every((line) => line.status === "ok")).toBe(true);
      expect(run.code).toBe(0);
    },
    CHECKER_DEADLINE_MS + CASE_SLACK_MS,
  );

  /** The eleven tiny scripts of a fake backend root; `overrides` replaces the source of some of them. */
  function fakeRoot(overrides: Readonly<Record<string, string>> = {}): string {
    const root = mkdtempSync(join(tmpdir(), "semprec-native-fake-"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
    for (const path of table) {
      const refusal = path.endsWith("validateRestoreLedgerCli.js")
        ? "Restore ledger validation failed"
        : path.endsWith("restoreTenantKeysCli.js")
          ? "Offline key restore failed"
          : "DATABASE_URL is not set";
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(
        join(root, path),
        overrides[path] ?? `console.error(${JSON.stringify(refusal)});\nprocess.exitCode = 1;\n`,
      );
    }
    return root;
  }

  it(
    "(c) names exactly the one entry that imports a missing module and exits 1",
    async () => {
      const broken = "services/semprec-agents/dist/serve.js";
      const root = fakeRoot({ [broken]: 'import "./missing.js";\n' });
      try {
        const run = await runChecker(["--root", root], FAST_CHECKER_DEADLINE_MS);
        expect(run.failure).toBeUndefined();
        expect(run.code).toBe(1);
        const report = parseReport(run.output);
        expect(report.filter((line) => line.status === "FAIL").map((line) => line.path)).toEqual([broken]);
        expect(report.find((line) => line.path === broken)?.reason).toContain("ERR_MODULE_NOT_FOUND");
        expect(report.filter((line) => line.status === "ok")).toHaveLength(10);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    FAST_CHECKER_DEADLINE_MS + CASE_SLACK_MS,
  );

  it(
    "(c) fails an entry for each module-resolution marker, a missing or wrong refusal, an output flood and a hang",
    async () => {
      const markers = [
        "ERR_MODULE_NOT_FOUND",
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
        "ERR_UNKNOWN_FILE_EXTENSION",
        "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
        "ERR_UNSUPPORTED_DIR_IMPORT",
        "Cannot find module",
      ];
      // The table's order is the checker's; the entries are picked by name so a reordering cannot change the case.
      const pick = (suffix: string): string => {
        const path = table.find((candidate) => candidate.endsWith(suffix));
        if (!path) throw new Error(`The checker's table has no entry ending in ${suffix}`);
        return path;
      };
      // Entries whose own refusal is "is not set": a marker printed beside it must still fail them.
      const markerEntries = [
        pick("db/runMigrationsCli.js"),
        pick("db/runSeedCli.js"),
        pick("db/verifyTenancyCli.js"),
        pick("tenancy/replayTenantDeletionsCli.js"),
        pick("semprec-api/dist/serve.js"),
        pick("semprec-agents/dist/serve.js"),
      ];
      // Its own refusal is a fixed text, so another entry's "is not set" must not pass for it.
      const wrong = pick("tenancy/validateRestoreLedgerCli.js");
      const silent = pick("tenancy/restoreTenantKeysCli.js");
      const flood = pick("observability/restoreTestResultCli.js");
      const hang = pick("semprec-ai-gateway/dist/serve.js");
      const fine = pick("semprec-transcribe/dist/serve.js");
      const overrides: Record<string, string> = {};
      // Each marker is printed next to a matching refusal, so a marker alone must fail the entry.
      markerEntries.forEach((path, index) => {
        overrides[path] =
          `console.error(${JSON.stringify(`${markers[index]} DATABASE_URL is not set`)});\nprocess.exitCode = 1;\n`;
      });
      overrides[silent] = "process.exitCode = 1;\n";
      overrides[wrong] = 'console.error("DATABASE_URL is not set");\nprocess.exitCode = 1;\n';
      overrides[flood] = 'process.stdout.write("x".repeat(2_000_000));\nsetInterval(() => {}, 1000);\n';
      overrides[hang] = "setInterval(() => {}, 1000);\n";
      const root = fakeRoot(overrides);
      try {
        const run = await runChecker(["--root", root], CHECKER_SLOW_DEADLINE_MS);
        expect(run.failure).toBeUndefined();
        expect(run.code).toBe(1);
        const report = parseReport(run.output);
        const failed = new Map(report.filter((line) => line.status === "FAIL").map((line) => [line.path, line.reason]));
        markers.forEach((marker, index) => {
          expect(failed.get(markerEntries[index] ?? "")).toContain(`module resolution failed (${marker})`);
        });
        expect(failed.get(silent)).toContain("no refusal matching");
        expect(failed.get(wrong)).toContain("no refusal matching");
        expect(failed.get(flood)).toContain("output exceeded 1000000 bytes");
        expect(failed.get(hang)).toContain("timed out after 30000 ms");
        expect(failed.size).toBe(10);
        expect(report.find((line) => line.path === fine)?.status).toBe("ok");
        // No line carries more than 500 characters of an entry's output.
        for (const line of report) expect(line.reason.length).toBeLessThan(600);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    CHECKER_SLOW_DEADLINE_MS + CASE_SLACK_MS,
  );

  it(
    "(c) hands each entry an environment of PATH and HOME only, however the checker itself was started",
    async () => {
      const keysOf = "Object.keys(process.env).filter((name) => name !== '__CF_USER_TEXT_ENCODING').sort().join(',')";
      const expected = ["HOME", "PATH"].filter((name) => process.env[name] !== undefined).join(",");
      const probe = `console.error(${keysOf} === ${JSON.stringify(expected)} ? 'environment is clean: DATABASE_URL is not set' : 'leaked: ' + ${keysOf});\nprocess.exitCode = 1;\n`;
      const overrides: Record<string, string> = {};
      for (const path of table) {
        overrides[path] = path.endsWith("validateRestoreLedgerCli.js")
          ? probe.replace("DATABASE_URL is not set", "Restore ledger validation failed")
          : path.endsWith("restoreTenantKeysCli.js")
            ? probe.replace("DATABASE_URL is not set", "Offline key restore failed")
            : probe;
      }
      const root = fakeRoot(overrides);
      try {
        const run = await runChecker(["--root", root], FAST_CHECKER_DEADLINE_MS, {
          NODE_OPTIONS: "--no-warnings",
          NODE_PATH: "/nonexistent",
          SEMPREC_CANARY: "must-not-reach-the-entries",
          DATABASE_URL: "postgres://must-not-reach-the-entries",
        });
        expect(run.failure).toBeUndefined();
        expect(parseReport(run.output).filter((line) => line.status === "FAIL")).toEqual([]);
        expect(run.code).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    FAST_CHECKER_DEADLINE_MS + CASE_SLACK_MS,
  );

  it(
    "(c) refuses a bad argument with exit 2 and runs nothing; a root that does not exist fails every entry",
    async () => {
      for (const args of [["--root"], ["--root", ""], ["--bogus"], ["--root", "a", "b"]]) {
        const run = await runChecker(args, FAST_CHECKER_DEADLINE_MS);
        expect(run.failure).toBeUndefined();
        expect(run.code).toBe(2);
        expect(run.output).toContain("Usage:");
        expect(run.output).not.toMatch(/^(ok|FAIL) /m);
      }
      const missing = join(tmpdir(), `semprec-native-missing-${randomUUID()}`);
      const run = await runChecker(["--root", missing], FAST_CHECKER_DEADLINE_MS);
      expect(run.failure).toBeUndefined();
      expect(run.code).toBe(1);
      const report = parseReport(run.output);
      expect(report.map((line) => line.path)).toEqual(table);
      expect(report.every((line) => line.status === "FAIL" && line.reason.startsWith("could not be started"))).toBe(
        true,
      );
    },
    5 * FAST_CHECKER_DEADLINE_MS,
  );
});

// Owned-database start of the services that can start today

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("Could not determine a free port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

interface ScratchDatabase {
  name: string;
  /** The owner (superuser) URL of the scratch database. */
  ownerUrl: string;
}

/**
 * Creates an owned scratch database on the test server, runs `fn` and drops it, asserting that it is absent. A
 * failure of `fn` stays the reported failure; a drop that fails after a successful `fn` fails the case.
 */
async function withScratchDatabase<T>(
  admin: Pool,
  baseUrl: string,
  fn: (db: ScratchDatabase) => Promise<T>,
): Promise<T> {
  const name = `semprec_native_${randomUUID().replaceAll("-", "")}`;
  // The identifier is a fixed prefix and the hexadecimal digits of a generated UUID, so it cannot break out of
  // the quoted name; CREATE and DROP DATABASE accept no bind parameters.
  const identifier = `"${name}"`;
  await admin.query(`CREATE DATABASE ${identifier}`);
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await fn({ name, ownerUrl: url.toString() }) };
  } catch (error) {
    outcome = { error };
  }
  let cleanupFailure: Error | undefined;
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${identifier} WITH (FORCE)`);
    const { rows } = await admin.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present",
      [name],
    );
    if (rows[0]?.present !== false) throw new Error("The scratch database is still present after DROP DATABASE");
  } catch (error) {
    cleanupFailure = error instanceof Error ? error : new Error("Scratch database cleanup failed", { cause: error });
  }
  if ("error" in outcome) {
    if (cleanupFailure) console.error(`Scratch database ${name} cleanup failed as well`);
    throw outcome.error;
  }
  if (cleanupFailure) throw cleanupFailure;
  return outcome.value;
}

/** `url` with the login of a runtime role. */
function asRole(url: string, role: "semprec_data" | "semprec_side", password: string): string {
  const next = new URL(url);
  next.username = role;
  next.password = password;
  return next.toString();
}

interface ServiceConfig {
  readonly dataUrl: string;
  readonly sideUrl: string;
  readonly port: number;
  readonly filesDir: string;
  readonly attachmentsDir: string;
}

interface ServiceCase {
  readonly name: string;
  readonly entry: string;
  readonly started: RegExp;
  readonly stopped: RegExp;
  readonly config: (config: ServiceConfig) => Record<string, string>;
  /** Runs against the started service, before SIGTERM; a failure fails the case after the child was stopped. */
  readonly probe?: (config: ServiceConfig) => Promise<void>;
}

const PLACEHOLDER_TOKEN = "placeholder-gateway-token";
/** A fixed 32-byte key for the placeholder configuration; it protects nothing. */
const PLACEHOLDER_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

const SERVICES: readonly ServiceCase[] = [
  {
    name: "semprec-ai-gateway",
    entry: "services/semprec-ai-gateway/dist/serve.js",
    started: /semprec-ai-gateway listening/,
    stopped: /semprec-ai-gateway shutdown complete/,
    config: (config) => ({
      SEMPREC_SIDE_DATABASE_URL: config.sideUrl,
      AI_GATEWAY_PORT: String(config.port),
      AI_GATEWAY_INTERNAL_TOKEN: PLACEHOLDER_TOKEN,
      AI_GATEWAY_STRUCTURED_PROVIDER: "anthropic",
      AI_GATEWAY_STRUCTURED_MODEL: "placeholder-model",
      ANTHROPIC_API_KEY: "placeholder-anthropic-key",
      AI_GATEWAY_STRUCTURED_INPUT_PRICE_PER_MTOK: "1",
      AI_GATEWAY_STRUCTURED_OUTPUT_PRICE_PER_MTOK: "1",
      PYANNOTEAI_API_KEY: "placeholder-pyannote-key",
      DEEPINFRA_API_KEY: "placeholder-deepinfra-key",
      AI_GATEWAY_PYANNOTE_PRICE_PER_AUDIO_HOUR: "1",
      AI_GATEWAY_DEEPINFRA_PRICE_PER_AUDIO_HOUR: "1",
      OPENAI_API_KEY: "placeholder-openai-key",
      AI_GATEWAY_OPENAI_STT_PRICE_PER_AUDIO_HOUR: "1",
      AI_GATEWAY_OPENAI_TTS_PRICE_PER_AUDIO_HOUR: "1",
      AI_GLOBAL_DAILY_CAP_USD: "1",
      AI_GLOBAL_MONTHLY_CAP_USD: "1",
    }),
  },
  {
    name: "semprec-agents",
    entry: "services/semprec-agents/dist/serve.js",
    started: /semprec-agents queue runtime started/,
    stopped: /semprec-agents shutdown complete/,
    config: (config) => ({
      SEMPREC_API_DATABASE_URL: config.dataUrl,
      CREDENTIALS_MASTER_KEY: PLACEHOLDER_MASTER_KEY,
      AI_GATEWAY_INTERNAL_TOKEN: PLACEHOLDER_TOKEN,
      AI_GATEWAY_BASE_URL: `http://127.0.0.1:${config.port}/internal/pi`,
      AGENT_MODEL: "placeholder-model",
      FILES_STORAGE_DIR: config.filesDir,
      MAIL_ATTACHMENTS_DIR: config.attachmentsDir,
    }),
  },
  {
    name: "semprec-api",
    entry: "services/semprec-api/dist/serve.js",
    started: /semprec-api listening/,
    stopped: /semprec-api shutdown complete/,
    config: (config) => ({
      SEMPREC_API_DATABASE_URL: config.dataUrl,
      SETUP_TOKEN: "placeholder-setup-token",
      AI_GATEWAY_INTERNAL_TOKEN: PLACEHOLDER_TOKEN,
      CREDENTIALS_MASTER_KEY: PLACEHOLDER_MASTER_KEY,
      PORT: String(config.port),
      FILES_STORAGE_DIR: config.filesDir,
      MAIL_ATTACHMENTS_DIR: config.attachmentsDir,
    }),
    probe: async (config) => {
      // `GET /healthz` reads the process heartbeat that the API wrote at start, through the runtime role.
      const response = await fetch(`http://127.0.0.1:${config.port}/healthz`, {
        signal: AbortSignal.timeout(HEALTHZ_LIMIT_MS),
      });
      const text = await response.text();
      expect(response.status).toBe(200);
      const body: unknown = JSON.parse(text);
      expect(body).toEqual({ status: "ok" });
    },
  },
  {
    name: "semprec-transcribe",
    entry: "services/semprec-transcribe/dist/serve.js",
    started: /semprec-transcribe queue runtime started/,
    stopped: /semprec-transcribe shutdown complete/,
    config: (config) => ({
      SEMPREC_API_DATABASE_URL: config.dataUrl,
      AI_GATEWAY_INTERNAL_TOKEN: PLACEHOLDER_TOKEN,
      FILES_STORAGE_DIR: config.filesDir,
      MAIL_ATTACHMENTS_DIR: config.attachmentsDir,
    }),
  },
];

describe("native entrypoints: an owned database and the compiled services", () => {
  let admin: Pool;
  let baseUrl: string;

  beforeAll(() => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is not set - is vitest's globalSetup wired up?");
    baseUrl = url;
    assertBuilt([
      "packages/data/dist/db/runMigrationsCli.js",
      "packages/data/dist/db/runSeedCli.js",
      ...SERVICES.map((service) => service.entry),
    ]);
    admin = new Pool({
      connectionString: baseUrl,
      max: 2,
      connectionTimeoutMillis: 10_000,
      statement_timeout: DROP_DEADLINE_MS,
    });
    admin.on("error", () => {
      // An idle admin client that the server drops is not a result of any case; the next query reports a real problem.
    });
  });

  afterAll(async () => {
    // Undefined when beforeAll failed before it created the pool; that failure is the one worth reporting.
    await admin?.end();
  });

  /**
   * Runs one compiled data CLI against an owned database as its owner, with only `PATH`, `HOME` and `DATABASE_URL`, so
   * it runs under the production tenant-scope default rather than the test process's `warn`.
   */
  async function runCli(cli: string, db: ScratchDatabase): Promise<ChildResult> {
    const env = explicitEnv({ DATABASE_URL: db.ownerUrl });
    expect(Object.keys(env)).not.toContain("SEMPREC_TENANT_SCOPE");
    return runNode([`packages/data/dist/db/${cli}`], env, SETUP_CLI_DEADLINE_MS);
  }

  /** Asserts that a CLI run ended on its own with exit code 0. */
  function expectSucceeded(cli: string, run: ChildResult): void {
    expect({ cli, failure: run.failure, code: run.code, output: excerpt(run.output) }).toMatchObject({
      failure: undefined,
      code: 0,
    });
  }

  /** Migrates and seeds an owned database with the compiled CLIs. */
  async function prepare(db: ScratchDatabase): Promise<void> {
    for (const cli of ["runMigrationsCli.js", "runSeedCli.js"]) expectSucceeded(cli, await runCli(cli, db));
  }

  it.each(SERVICES)(
    "(d) $name starts from its compiled serve.js as the runtime role and exits 0 on SIGTERM",
    async (service) => {
      const scratchDirs = [
        mkdtempSync(join(tmpdir(), "semprec-native-files-")),
        mkdtempSync(join(tmpdir(), "semprec-native-mail-")),
      ];
      try {
        await withScratchDatabase(admin, baseUrl, async (db) => {
          await prepare(db);
          // `ALTER ROLE` accepts no bind parameters: the role names are fixed literals and the password a UUID.
          // The roles belong to the whole test server, and every createRuntimeRolePool call sets its own password again.
          const password = randomUUID();
          await admin.query(`ALTER ROLE semprec_data WITH PASSWORD '${password}'`);
          await admin.query(`ALTER ROLE semprec_side WITH PASSWORD '${password}'`);
          const config: ServiceConfig = {
            dataUrl: asRole(db.ownerUrl, "semprec_data", password),
            sideUrl: asRole(db.ownerUrl, "semprec_side", password),
            port: await freePort(),
            filesDir: scratchDirs[0] ?? "",
            attachmentsDir: scratchDirs[1] ?? "",
          };
          // This process has SEMPREC_TENANT_SCOPE=warn, which would hide a start-up call outside any tenant scope, so the
          // child's environment must not carry it.
          expect(process.env.SEMPREC_TENANT_SCOPE).toBeDefined();
          const env = explicitEnv(service.config(config));
          expect(Object.keys(env)).not.toContain("SEMPREC_TENANT_SCOPE");
          const run = startNode([service.entry], env, START_WAIT_MS + SHUTDOWN_WAIT_MS + CASE_SLACK_MS);
          const reached = await waitForOutput(run, service.started, START_WAIT_MS);
          if (!reached) {
            run.process.kill("SIGKILL");
            const failed = await run.result;
            throw new Error(`${service.name} did not log its start line: ${excerpt(failed.output)}`);
          }
          let probeFailure: Error | undefined;
          try {
            await service.probe?.(config);
          } catch (error) {
            probeFailure = error instanceof Error ? error : new Error("The service probe failed", { cause: error });
          }
          const stopped = await terminate(run, SHUTDOWN_WAIT_MS);
          if (probeFailure) throw probeFailure;
          expect({
            exitedInTime: stopped.exitedInTime,
            code: stopped.result.code,
            failure: stopped.result.failure,
          }).toEqual({
            exitedInTime: true,
            code: 0,
            failure: undefined,
          });
          expect(stopped.result.output).toMatch(service.stopped);
        });
      } finally {
        for (const directory of scratchDirs) rmSync(directory, { recursive: true, force: true });
      }
    },
    DOWNSTREAM_CASE_TIMEOUT_MS,
  );

  /** The legacy job of case (e); a fixed key, so the migrated job is found by it. */
  const LEGACY_JOB_KEY = "native-entry-legacy-heartbeat-fire";

  interface JobRow {
    task_identifier: string;
    key: string | null;
    payload: unknown;
  }

  /**
   * The jobs of the queue with a key, with their envelope. graphile-worker's public `jobs` view does not project
   * the payload, so this reads its private tables, checked against graphile-worker 0.17.3; the access stays here.
   */
  async function jobsWithKey(owner: Pool, key: string): Promise<JobRow[]> {
    const { rows } = await owner.query<JobRow>(
      `SELECT t.identifier AS task_identifier, j.key, j.payload::jsonb AS payload
         FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id
        WHERE j.key = $1`,
      [key],
    );
    return rows;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  it(
    "(e) the deploy order under strict scope: a second migration run moves a legacy heartbeatFire job and the tenancy verification passes",
    async () => {
      await withScratchDatabase(admin, baseUrl, async (db) => {
        await prepare(db);
        const owner = new Pool({
          connectionString: db.ownerUrl,
          max: 1,
          connectionTimeoutMillis: 10_000,
          statement_timeout: 30_000,
        });
        owner.on("error", () => {
          // An idle client that the server drops is not a result of this case; the next query reports a real problem.
        });
        try {
          // The owner (superuser) pool reads the seeded rows of every tenant; this case asserts the deploy step, not isolation.
          const tenants = await owner.query<{ id: string }>("SELECT id FROM tenants");
          expect(tenants.rows).toHaveLength(1);
          const tenantId = tenants.rows[0]?.id;
          const heartbeats = await owner.query<{ id: string; tenant_id: string }>(
            "SELECT id, tenant_id FROM project_heartbeats WHERE action_id = $1",
            [DRIFT_CHECK_ACTION_ID],
          );
          expect(heartbeats.rows).toHaveLength(1);
          const heartbeat = heartbeats.rows[0];
          expect(heartbeat?.tenant_id).toBe(tenantId);

          // A job with the retired task name and an envelope without a tenant; only the queue's public function can
          // produce this state, since no current code enqueues the name.
          await owner.query(
            "SELECT graphile_worker.add_job('heartbeatFire', $1::json, job_key => $2, max_attempts => 3)",
            [JSON.stringify({ traceId: randomUUID(), payload: { heartbeatId: heartbeat?.id } }), LEGACY_JOB_KEY],
          );
          expect(await jobsWithKey(owner, LEGACY_JOB_KEY)).toMatchObject([{ task_identifier: "heartbeatFire" }]);

          expectSucceeded("runMigrationsCli.js", await runCli("runMigrationsCli.js", db));

          const moved = await jobsWithKey(owner, LEGACY_JOB_KEY);
          expect(moved.map((job) => job.task_identifier)).toEqual(["heartbeatFireCore"]);
          const envelope = moved[0]?.payload;
          expect(isRecord(envelope) ? envelope.tenantId : undefined).toBe(tenantId);
          const remaining = await owner.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM graphile_worker._private_jobs j
             JOIN graphile_worker._private_tasks t ON t.id = j.task_id WHERE t.identifier = 'heartbeatFire'`,
          );
          expect(remaining.rows[0]?.count).toBe("0");

          const verified = await runCli("verifyTenancyCli.js", db);
          expectSucceeded("verifyTenancyCli.js", verified);
          expect(verified.output).toContain("tenancy: verified");
        } finally {
          await owner.end();
        }
      });
    },
    DEPLOY_ORDER_CASE_TIMEOUT_MS,
  );
});
