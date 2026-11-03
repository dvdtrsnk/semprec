import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { getTestPool } from "../testSupport/testDb.js";

const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const blockRoot = resolve(backend, "../shared/block-model");
const runtime = join(backend, "packages/data/src/__tests__/fixtures/mailThreadBackfillCliRuntime.mjs");
const compiled = join(backend, "packages/data/dist/db/runMigrationsCli.js");
const source = join(backend, "packages/data/src/db/runMigrationsCli.ts");

async function runCli(databaseUrl: string, blockEntry: string): Promise<void> {
  await new Promise<void>((resolveResult, reject) => {
    const child = spawn(process.execPath, [runtime], {
      cwd: backend,
      env: { ...process.env, DATABASE_URL: databaseUrl, BATCH17_BLOCK_MODEL_ENTRY: blockEntry },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let bytes = 0;
    let failed: { error: unknown } | undefined;
    const secondary: unknown[] = [];
    const record = (error: unknown) => {
      if (failed) secondary.push(error);
      else failed = { error };
    };
    const stop = (error: Error) => {
      if (failed) return;
      record(error);
      try {
        if (!child.kill("SIGKILL")) secondary.push(new Error("Could not signal owned CLI child"));
      } catch (killError) {
        secondary.push(killError);
      }
    };
    const timer = setTimeout(() => stop(new Error("Migration CLI fixture timed out")), 60_000);
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_000_000) stop(new Error("Migration CLI fixture output exceeded limit"));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", record);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failed && secondary.length)
        reject(new AggregateError([failed.error, ...secondary], "CLI child and cleanup failed"));
      else if (failed)
        reject(failed.error instanceof Error ? failed.error : new Error("CLI child failed", { cause: failed.error }));
      else if (secondary.length) reject(new AggregateError(secondary, "CLI child cleanup failed"));
      else if (code !== 0)
        reject(new Error(`Migration CLI fixture failed (exit ${String(code)}, signal ${String(signal)})`));
      else {
        console.info(`BATCH17_CLI childPid=${String(child.pid)} exit=${code} outputBytes=${bytes}`);
        resolveResult();
      }
    });
  });
}

it("runs the compiled migration root twice and queues one keyed mail-thread backfill", async () => {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) throw new Error("Missing isolated test database URL");
  if (statSync(compiled).mtimeMs < statSync(source).mtimeMs)
    throw new Error("Build backend artifacts before this test");
  const admin = getTestPool();
  const name = `batch17_${randomUUID().replaceAll("-", "")}`;
  // The database identifier consists only of this fixed prefix and generated hexadecimal UUID digits.
  const identifier = `"${name}"`;
  let created = false;
  let temporary: string | undefined;
  let database: Pool | undefined;
  let primary: { error: unknown } | undefined;
  const cleanup: unknown[] = [];
  try {
    await admin.query(`CREATE DATABASE ${identifier}`);
    created = true;
    const url = new URL(baseUrl);
    url.pathname = `/${name}`;
    database = new Pool({ connectionString: url.toString() });
    temporary = mkdtempSync(join(blockRoot, "node_modules/.batch17-"));
    const build = spawnSync(
      process.execPath,
      [
        join(backend, "node_modules/typescript/bin/tsc"),
        "-p",
        join(blockRoot, "tsconfig.json"),
        "--noEmit",
        "false",
        "--declaration",
        "false",
        "--incremental",
        "false",
        "--outDir",
        temporary,
      ],
      { cwd: backend, timeout: 25_000, maxBuffer: 1_000_000, encoding: "utf8" },
    );
    if (build.error || build.status !== 0)
      throw new Error(`Temporary block-model build failed (${String(build.status)})`);
    const blockEntry = join(temporary, "index.js");
    const entrySha256 = createHash("sha256").update(readFileSync(compiled)).digest("hex");
    console.info(
      `BATCH17_CLI_BOOTSTRAP argv=node packages/data/src/__tests__/fixtures/mailThreadBackfillCliRuntime.mjs compiledSha256=${entrySha256}`,
    );
    console.info(
      "BATCH17_BLOCK_BUILD argv=node typescript/bin/tsc -p shared/block-model/tsconfig.json --noEmit false --declaration false --incremental false --outDir <owned-temp>",
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await runCli(url.toString(), blockEntry);
      const { rows } = await database.query<{ key: string | null; max_attempts: number }>(
        "SELECT key, max_attempts FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
        ["mailThreadBackfill"],
      );
      expect(rows).toEqual([{ key: "mail-thread-backfill", max_attempts: 3 }]);
    }
  } catch (error) {
    primary = { error };
  }
  try {
    await database?.end();
  } catch (error) {
    cleanup.push(error);
  }
  try {
    if (created) await admin.query(`DROP DATABASE ${identifier}`);
  } catch (error) {
    cleanup.push(error);
  }
  try {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  } catch (error) {
    cleanup.push(error);
  }
  try {
    await admin.end();
  } catch (error) {
    cleanup.push(error);
  }
  if (primary && cleanup.length)
    throw new AggregateError([primary.error, ...cleanup], "CLI fixture and cleanup failed");
  if (primary) throw primary.error;
  if (cleanup.length) throw new AggregateError(cleanup, "CLI fixture cleanup failed");
}, 120_000);
