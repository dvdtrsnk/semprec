import { ensureQueueSchema, grantQueueSchemaPrivileges } from "@semprec/queue";
import { runAsSystem } from "@semprec/shared";
import { createPool } from "./pool.js";
import { logger } from "./logger.js";
import { runMigrations } from "./migrate.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// A migration is not bounded by the runtime statement timeout.
const pool = createPool(connectionString, { statementTimeoutMs: 0 });

try {
  await runAsSystem("deploy migrations", async () => {
    await runMigrations(pool);
    // graphile-worker's schema exists only after ensureQueueSchema, so semprec_side's grants on it cannot
    // live in the SQL migrations; testSupport/globalSetup.ts makes the same two calls for tests.
    await ensureQueueSchema(pool);
    await grantQueueSchemaPrivileges(pool);
  });
} finally {
  try {
    await pool.end();
  } catch (err) {
    logger.error({ err }, "Failed to end the migration pool");
  }
}
