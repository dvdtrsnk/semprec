import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { Pool } from "pg";
import { ensureQueueSchema } from "@semprec/queue";
import { runMigrations } from "../db/migrate.js";

const PORT = 54_329;

/** vitest globalSetup: one embedded Postgres instance for the whole test run. */
export default async function setup(): Promise<() => Promise<void>> {
  const databaseDir = await mkdtemp(path.join(tmpdir(), "semprec-pg-"));
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: "postgres",
    password: "postgres",
    port: PORT,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase("semprec_test");

  const connectionString = `postgresql://postgres:postgres@localhost:${PORT}/semprec_test`;
  process.env.TEST_DATABASE_URL = connectionString;
  // Deterministic 32-byte test key for @semprec/credentials (issue #26) — never used outside tests.
  process.env.CREDENTIALS_MASTER_KEY ??= Buffer.alloc(32, 7).toString("base64");

  const pool = new Pool({ connectionString });
  await runMigrations(pool);
  await ensureQueueSchema(pool);
  await pool.end();

  return async () => {
    await pg.stop();
    await rm(databaseDir, { recursive: true, force: true });
  };
}
