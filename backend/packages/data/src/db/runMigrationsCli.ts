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
    // Issue #243: graphile-worker's own schema doesn't exist until ensureQueueSchema creates it, so
    // semprec_side's grants on it can't live in the SQL migrations above — this CLI is the real-deploy
    // invocation point, matching testSupport/globalSetup.ts's test-time call to the same two functions.
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
