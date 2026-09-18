import { ensureQueueSchema, grantQueueSchemaPrivileges } from "@semprec/queue";
import { createPool } from "./pool.js";
import { runMigrations } from "./migrate.js";
import { runDocHistoryCutoverMigration } from "../docs/docHistoryCutoverMigration.js";
import { runAgentRunsActorUserIdCutoverMigration } from "../agentRuns/agentRunsActorUserIdCutoverMigration.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const pool = createPool(connectionString);
try {
  await runMigrations(pool);
  await runDocHistoryCutoverMigration(pool);
  await runAgentRunsActorUserIdCutoverMigration(pool);
  // Issue #243: graphile-worker's own schema doesn't exist until ensureQueueSchema creates it, so
  // semprec_side's grants on it can't live in the SQL migrations above — this CLI is the real-deploy
  // invocation point, matching testSupport/globalSetup.ts's test-time call to the same two functions.
  await ensureQueueSchema(pool);
  await grantQueueSchemaPrivileges(pool);
} finally {
  await pool.end();
}
