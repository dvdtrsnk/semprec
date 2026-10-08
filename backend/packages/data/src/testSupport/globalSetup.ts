import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { ensureQueueSchema, grantQueueSchemaPrivileges } from "@semprec/queue";
import { runMigrations } from "../db/migrate.js";
import { runDocHistoryCutoverMigration } from "../docs/docHistoryCutoverMigration.js";
import { runAgentRunsActorUserIdCutoverMigration } from "../agentRuns/agentRunsActorUserIdCutoverMigration.js";
import { runApprovalRequestExecutionStatusCutoverMigration } from "../mcp/approvalRequestExecutionStatusCutoverMigration.js";
import { runHeartbeatFireQueueSplitMigration } from "../scheduler/heartbeatFireQueueSplitMigration.js";
import { createPool } from "../db/pool.js";
import { runTenantCutoverMigrations } from "../db/tenantCutoverMigrations.js";
import { activateCzechHunspellSearch } from "../mail/czechHunspellSearch.js";
import { preserveFailingExitCode } from "./preserveFailingExitCode.js";
import { sweepStalePostgresDirs } from "./stalePostgresDirs.js";

/**
 * A fixed port made any second test run on the same machine fail in a way that reads like a
 * broken test suite rather than a port clash: `initdb` succeeds, the postmaster then cannot
 * bind, and vitest reports "No test files found". Two git worktrees of this repo, or two CI
 * jobs sharing a runner, are enough to trigger it.
 *
 * Asking the kernel for a free port still races against whoever binds it in between, so
 * `SEMPREC_TEST_PG_PORT` stays available to pin one explicitly.
 */
async function choosePort(): Promise<number> {
  const configured = process.env.SEMPREC_TEST_PG_PORT;
  if (configured) {
    const port = Number(configured);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`SEMPREC_TEST_PG_PORT is not a valid port number: ${configured}`);
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

/** vitest globalSetup: one embedded Postgres instance for the whole test run. */
export default async function setup(): Promise<() => Promise<void>> {
  preserveFailingExitCode();

  const removedStaleDirs = await sweepStalePostgresDirs({ tmpDir: tmpdir() });
  if (removedStaleDirs.length > 0) {
    console.warn(
      `Swept stale semprec-pg-* director${removedStaleDirs.length === 1 ? "y" : "ies"}: ${removedStaleDirs.join(", ")}`,
    );
  }

  const port = await choosePort();
  const databaseDir = await mkdtemp(path.join(tmpdir(), "semprec-pg-"));
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
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

    await pg.createDatabase("semprec_test");

    const connectionString = `postgresql://postgres:postgres@localhost:${port}/semprec_test`;
    process.env.TEST_DATABASE_URL = connectionString;
    // Deterministic 32-byte test key for @semprec/credentials (issue #26) — never used outside tests.
    process.env.CREDENTIALS_MASTER_KEY ??= Buffer.alloc(32, 7).toString("base64");

    const pool = new Pool({ connectionString });
    const tenantPool = createPool(connectionString, { role: "semprec_data" });
    try {
      await runAsSystem("test database setup", async () => {
        await runMigrations(pool);
        await activateCzechHunspellSearch(pool);
        await runDocHistoryCutoverMigration(pool);
        await runAgentRunsActorUserIdCutoverMigration(pool);
        await runApprovalRequestExecutionStatusCutoverMigration(pool);
        await runTenantCutoverMigrations(tenantPool);
        await ensureQueueSchema(pool);
        await grantQueueSchemaPrivileges(pool);
        await runHeartbeatFireQueueSplitMigration(pool);
      });
    } finally {
      await tenantPool.end();
    }

    // Tenant zero's id is the stable anchor of every test: `resetDatabase` re-creates it with this id.
    const sole = await pool.query<{ id: string | null }>("SELECT app_sole_tenant() AS id");
    const tenantZeroId = sole.rows[0]?.id;
    if (!tenantZeroId) {
      throw new Error("globalSetup: app_sole_tenant() returned NULL after the migrations — tenant zero is missing");
    }
    process.env.TEST_TENANT_ZERO_ID = tenantZeroId;
    // Tests enqueue jobs outside any tenant scope; the queue only runs those in the sole tenant on
    // this opt-in. Removed together with the fallback by #1061.
    process.env.SEMPREC_LEGACY_ENVELOPE_FALLBACK ??= "1";
    // Test database only: the guard makes a second tenant impossible, and the two-tenant harness
    // needs one. IF EXISTS keeps this working once the go-live migration removes the guard itself.
    await pool.query("DROP INDEX IF EXISTS tenants_single_tenant_guard");
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
