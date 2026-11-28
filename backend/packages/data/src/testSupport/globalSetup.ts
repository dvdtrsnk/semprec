import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { runAsSystem } from "@alldots/shared";
import { ensureQueueSchema } from "@alldots/queue";
import { installQueueSchema } from "../db/queueSchema.js";
import { runMigrations } from "../db/migrate.js";
import { preserveFailingExitCode } from "./preserveFailingExitCode.js";
import { sweepStalePostgresDirs } from "./stalePostgresDirs.js";
import { ModuleRegistry } from "@alldots/module-registry";
import { BLOCK_TYPES } from "@alldots/block-model";

/**
 * A free port, so parallel runs (worktrees, shared CI runners) do not clash; a clash otherwise surfaces as "No test
 * files found". Probing races, so `ALLDOTS_TEST_PG_PORT` can pin one.
 */
async function choosePort(): Promise<number> {
  const configured = process.env.ALLDOTS_TEST_PG_PORT;
  if (configured) {
    const port = Number(configured);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`ALLDOTS_TEST_PG_PORT is not a valid port number: ${configured}`);
    }
    return port;
  }
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("Could not determine a free port for the test database")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** Migrated once per run; integration workers clone it, so nothing may stay connected to it after setup. */
const TEMPLATE_DATABASE = "alldots_test";

/** vitest globalSetup: one embedded Postgres for the whole run. */
export default async function setup(): Promise<() => Promise<void>> {
  preserveFailingExitCode();
  const sharedPath = fileURLToPath(new URL("../../../shared/src/index.ts", import.meta.url));
  const queuePath = fileURLToPath(new URL("../../../queue/src/index.ts", import.meta.url));
  const registryPath = fileURLToPath(new URL("../../../module-registry/src/index.ts", import.meta.url));
  const blockPath = fileURLToPath(new URL("../../../../../shared/block-model/src/index.ts", import.meta.url));
  const sourceRunAsSystem: unknown = (await import(sharedPath)).runAsSystem;
  const sourceEnsureQueueSchema: unknown = (await import(queuePath)).ensureQueueSchema;
  const SourceModuleRegistry: unknown = (await import(registryPath)).ModuleRegistry;
  const sourceBlockTypes: unknown = (await import(blockPath)).BLOCK_TYPES;
  if (
    runAsSystem !== sourceRunAsSystem ||
    ensureQueueSchema !== sourceEnsureQueueSchema ||
    ModuleRegistry !== SourceModuleRegistry ||
    BLOCK_TYPES !== sourceBlockTypes
  ) {
    throw new Error("Global setup workspace roots must resolve to source modules");
  }

  const removedStaleDirs = await sweepStalePostgresDirs({ tmpDir: tmpdir() });
  if (removedStaleDirs.length > 0) {
    console.warn(
      `Swept stale alldots-pg-* director${removedStaleDirs.length === 1 ? "y" : "ies"}: ${removedStaleDirs.join(", ")}`,
    );
  }

  const port = await choosePort();
  const databaseDir = await mkdtemp(path.join(tmpdir(), "alldots-pg-"));
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    // ICU collations need UTF8; initdb picks SQL_ASCII on a C-locale host.
    initdbFlags: ["--encoding=UTF8"],
    postgresFlags: [
      // Every worker has its own database and pools; the default 100 connections run out with several workers.
      "-c",
      "max_connections=500",
      // The cluster is thrown away after the run, so durability buys nothing and costs a flush per commit.
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
    ],
  });

  async function removeDatabaseDir(): Promise<void> {
    try {
      await rm(databaseDir, { recursive: true, force: true });
    } catch {
      // Best effort: a failure here must not shadow the error that triggered this cleanup.
    }
  }

  async function handleSignal(signal: NodeJS.Signals): Promise<void> {
    try {
      await pg.stop();
    } catch {
      // Best effort: still remove the data directory below.
    }
    await removeDatabaseDir();
    process.kill(process.pid, signal);
  }

  let onSignal: NodeJS.SignalsListener | undefined;

  try {
    await pg.initialise();
    await pg.start();

    onSignal = (signal) => {
      void handleSignal(signal);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    const bootstrap = pg.getPgClient("postgres", "127.0.0.1");
    let bootstrapFailure: { error: unknown } | undefined;
    try {
      await bootstrap.connect();
      await bootstrap.query(`CREATE DATABASE "${TEMPLATE_DATABASE}"`);
    } catch (error) {
      bootstrapFailure = { error };
    }
    try {
      await bootstrap.end();
    } catch (error) {
      if (bootstrapFailure) {
        throw new AggregateError([bootstrapFailure.error, error], "Test database bootstrap and client cleanup failed", {
          cause: error,
        });
      }
      throw error;
    }
    if (bootstrapFailure) throw bootstrapFailure.error;

    const connectionString = `postgresql://postgres:postgres@127.0.0.1:${port}/${TEMPLATE_DATABASE}`;
    // The e2e tier uses this database directly; integration workers clone it (`workerDatabase.ts`).
    process.env.TEST_DATABASE_URL = connectionString;
    process.env.TEST_TEMPLATE_DATABASE = TEMPLATE_DATABASE;
    process.env.TEST_ADMIN_DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    // Roles are cluster-wide, so all workers share one runtime-role password (`createRuntimeRolePool`).
    process.env.TEST_RUNTIME_ROLE_PASSWORD = randomUUID();
    // ALLDOTS_TENANT_SCOPE is chosen per test file by `tenantScopeMode.ts`; the e2e config pins `warn`.
    // Deterministic test-only credentials key.
    process.env.CREDENTIALS_MASTER_KEY ??= Buffer.alloc(32, 7).toString("base64");

    const pool = new Pool({ connectionString });
    await runAsSystem("test database setup", async () => {
      await runMigrations(pool);
      await installQueueSchema(pool);
    });

    // `resetDatabase` re-creates tenant zero with this id.
    const sole = await pool.query<{ id: string | null }>("SELECT app_sole_tenant() AS id");
    const tenantZeroId = sole.rows[0]?.id;
    if (!tenantZeroId) {
      throw new Error("globalSetup: app_sole_tenant() returned NULL after the migrations — tenant zero is missing");
    }
    process.env.TEST_TENANT_ZERO_ID = tenantZeroId;
    await pool.end();
  } catch (err) {
    if (onSignal) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    try {
      await pg.stop();
    } catch {
      // Best effort: still remove the data directory below, and rethrow the original error.
    }
    await removeDatabaseDir();
    throw err;
  }

  return async () => {
    if (onSignal) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    await pg.stop();
    await rm(databaseDir, { recursive: true, force: true });
  };
}
