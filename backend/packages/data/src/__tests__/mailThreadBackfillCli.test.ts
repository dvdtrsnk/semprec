import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { expect, it } from "vitest";

const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const compiled = join(backend, "packages/data/dist/db/runMigrationsCli.js");
const source = join(backend, "packages/data/src/db/runMigrationsCli.ts");

async function runCli(databaseUrl: string): Promise<void> {
  await new Promise<void>((resolveResult, reject) => {
    const child = spawn(process.execPath, [compiled], {
      cwd: backend,
      env: { ...process.env, DATABASE_URL: databaseUrl, NODE_OPTIONS: undefined, NODE_PATH: undefined },
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
    const timer = setTimeout(() => stop(new Error("Migration CLI fixture timed out")), 40_000);
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
        console.info(
          `BATCH17_CLI ${JSON.stringify({ argv: [process.execPath, compiled], cwd: backend, pid: child.pid, exit: code, outputBytes: bytes })}`,
        );
        resolveResult();
      }
    });
  });
}

interface ScenarioResult {
  failure: { value: unknown } | undefined;
  creatorSettled: boolean;
  observedCreated: boolean;
  creatorObservedLive: boolean;
  databaseAbsent: boolean;
}

async function runScenario(withholdAcknowledgement: boolean): Promise<ScenarioResult> {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) throw new Error("Missing isolated test database URL");
  if (statSync(compiled).mtimeMs < statSync(source).mtimeMs)
    throw new Error("Build backend artifacts before this test");
  const poolOptions = { max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 10_000, query_timeout: 12_000 };
  const operationPool = new Pool({ connectionString: baseUrl, ...poolOptions });
  const observer = new Pool({ connectionString: baseUrl, ...poolOptions });
  const name = `batch17_${randomUUID().replaceAll("-", "")}`;
  // The database identifier is a fixed prefix and hexadecimal digits from a generated UUID.
  const identifier = `"${name}"`;
  let database: Pool | undefined;
  let attemptOwned = false;
  let creatorSettled = false;
  let observedCreated = false;
  let creatorObservedLive = false;
  let databaseAbsent = false;
  let creator: import("pg").PoolClient | undefined;
  let creatorIdentity: { pid: number; backend_start: string } | undefined;
  let removalIdentity: { pid: number; backend_start: string } | undefined;
  let primary: { value: unknown } | undefined;
  const cleanup: unknown[] = [];
  const waitForOwnedBackend = async (identity: { pid: number; backend_start: string }): Promise<void> => {
    const deadline = Date.now() + 5_000;
    do {
      const active = await observer.query<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz) AS present",
        [identity.pid, identity.backend_start],
      );
      if (active.rows[0]?.present === false) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    } while (Date.now() < deadline);
    throw new Error("Owned database backend did not settle");
  };
  try {
    const collision = await observer.query<{ present: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present",
      [name],
    );
    if (collision.rows[0]?.present !== false) throw new Error("Generated fixture database name is unavailable");
    creator = await operationPool.connect();
    const identity = await creator.query<{ pid: number; backend_start: string }>(
      "SELECT pid, backend_start::text FROM pg_stat_activity WHERE pid = pg_backend_pid()",
    );
    if (!identity.rows[0]) throw new Error("Could not identify the owned database creator");
    creatorIdentity = identity.rows[0];
    attemptOwned = true;
    await creator.query(`CREATE DATABASE ${identifier}`);
    if (withholdAcknowledgement) {
      const observed = await observer.query<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present",
        [name],
      );
      observedCreated = observed.rows[0]?.present === true;
      const live = await observer.query<{ present: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz) AS present",
        [creatorIdentity.pid, creatorIdentity.backend_start],
      );
      creatorObservedLive = live.rows[0]?.present === true;
      throw new Error("Injected lost CREATE acknowledgement");
    }
    creator.release(true);
    creator = undefined;
    await waitForOwnedBackend(creatorIdentity);
    creatorSettled = true;
    const url = new URL(baseUrl);
    url.pathname = `/${name}`;
    database = new Pool({ connectionString: url.toString(), ...poolOptions });
    for (const artifact of [
      compiled,
      join(backend, "packages/shared/dist/index.js"),
      join(backend, "packages/queue/dist/index.js"),
      join(backend, "packages/module-registry/dist/index.js"),
      join(backend, "../shared/block-model/dist/index.js"),
    ]) {
      console.info(
        `BATCH19_ARTIFACT ${artifact} sha256=${createHash("sha256").update(readFileSync(artifact)).digest("hex")}`,
      );
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await runCli(url.toString());
      const { rows } = await database.query<{ key: string | null; max_attempts: number }>(
        "SELECT key, max_attempts FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
        ["mailThreadBackfill"],
      );
      expect(rows).toEqual([{ key: "mail-thread-backfill", max_attempts: 3 }]);
    }
  } catch (error) {
    primary = { value: error };
  }
  try {
    if (creator) creator.release(true);
  } catch (error) {
    cleanup.push(error);
  }
  if (attemptOwned && creatorIdentity && !creatorSettled) {
    try {
      await waitForOwnedBackend(creatorIdentity);
      creatorSettled = true;
    } catch (error) {
      cleanup.push(error);
    }
  }

  let consumersSettled = false;
  try {
    await database?.end();
    consumersSettled = true;
  } catch (error) {
    cleanup.push(error);
  }
  if (attemptOwned && creatorSettled && consumersSettled) {
    const removal = new Pool({ connectionString: baseUrl, ...poolOptions });
    let removalClient: import("pg").PoolClient | undefined;
    try {
      removalClient = await removal.connect();
      const identity = await removalClient.query<{ pid: number; backend_start: string }>(
        "SELECT pid, backend_start::text FROM pg_stat_activity WHERE pid = pg_backend_pid()",
      );
      if (!identity.rows[0]) throw new Error("Could not identify the owned database remover");
      removalIdentity = identity.rows[0];
      await removalClient.query(`DROP DATABASE IF EXISTS ${identifier}`);
    } catch (error) {
      cleanup.push(error);
    }
    try {
      if (removalClient) removalClient.release(true);
    } catch (error) {
      cleanup.push(error);
    }
    if (removalIdentity) {
      try {
        await waitForOwnedBackend(removalIdentity);
        const absent = await observer.query<{ present: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present",
          [name],
        );
        databaseAbsent = absent.rows[0]?.present === false;
        if (!databaseAbsent) throw new Error("Owned fixture database removal was not established");
      } catch (error) {
        cleanup.push(error);
      }
    }
    try {
      await removal.end();
    } catch (error) {
      cleanup.push(error);
    }
  }
  try {
    await operationPool.end();
  } catch (error) {
    cleanup.push(error);
  }
  try {
    await observer.end();
  } catch (error) {
    cleanup.push(error);
  }
  if (cleanup.length)
    throw new AggregateError(primary ? [primary.value, ...cleanup] : cleanup, "CLI fixture cleanup failed");
  console.info(
    `BATCH17_DB ${JSON.stringify({ creator: creatorIdentity, remover: removalIdentity, creatorObservedLive, creatorSettled, databaseAbsent, acknowledgementWithheld: withholdAcknowledgement })}`,
  );
  return { failure: primary, creatorSettled, observedCreated, creatorObservedLive, databaseAbsent };
}

it("reaches application configuration refusal without a loader", () => {
  const result = spawnSync(process.execPath, [compiled], {
    cwd: backend,
    env: { ...process.env, DATABASE_URL: undefined, NODE_OPTIONS: undefined, NODE_PATH: undefined },
    encoding: "utf8",
    timeout: 40_000,
    maxBuffer: 2_000_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("DATABASE_URL is not set");
  expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
});

it("runs the compiled migration root twice and queues one keyed mail-thread backfill", async () => {
  const result = await runScenario(false);
  if (result.failure) throw result.failure.value;
  expect(result.creatorSettled).toBe(true);
  expect(result.databaseAbsent).toBe(true);
}, 240_000);

it("settles its creator and removes the database when a committed create acknowledgement is lost", async () => {
  const result = await runScenario(true);
  expect(result.failure?.value).toMatchObject({ message: "Injected lost CREATE acknowledgement" });
  expect(result.observedCreated).toBe(true);
  expect(result.creatorObservedLive).toBe(true);
  expect(result.creatorSettled).toBe(true);
  expect(result.databaseAbsent).toBe(true);
}, 240_000);
