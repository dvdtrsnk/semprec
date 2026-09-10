import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { ensureQueueSchema } from "@semprec/queue";
import { runMigrations } from "../db/migrate.js";
import { runDocHistoryCutoverMigration } from "../docs/docHistoryCutoverMigration.js";

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
  const port = await choosePort();
  const databaseDir = await mkdtemp(path.join(tmpdir(), "semprec-pg-"));
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase("semprec_test");

  const connectionString = `postgresql://postgres:postgres@localhost:${port}/semprec_test`;
  process.env.TEST_DATABASE_URL = connectionString;
  // Deterministic 32-byte test key for @semprec/credentials (issue #26) — never used outside tests.
  process.env.CREDENTIALS_MASTER_KEY ??= Buffer.alloc(32, 7).toString("base64");

  const pool = new Pool({ connectionString });
  await runMigrations(pool);
  await runDocHistoryCutoverMigration(pool);
  await ensureQueueSchema(pool);
  await pool.end();

  return async () => {
    await pg.stop();
    await rm(databaseDir, { recursive: true, force: true });
  };
}
