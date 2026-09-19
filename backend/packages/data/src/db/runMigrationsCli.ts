import { ensureQueueSchema, grantQueueSchemaPrivileges } from "@semprec/queue";
import { createPool } from "./pool.js";
import { runMigrations } from "./migrate.js";
import { runDocHistoryCutoverMigration } from "../docs/docHistoryCutoverMigration.js";
import { runAgentRunsActorUserIdCutoverMigration } from "../agentRuns/agentRunsActorUserIdCutoverMigration.js";
import { runApprovalRequestExecutionStatusCutoverMigration } from "../mcp/approvalRequestExecutionStatusCutoverMigration.js";
import { runHeartbeatFireQueueSplitMigration } from "../scheduler/heartbeatFireQueueSplitMigration.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const pool = createPool(connectionString);
try {
  await runMigrations(pool);
  await runDocHistoryCutoverMigration(pool);
  await runAgentRunsActorUserIdCutoverMigration(pool);
  await runApprovalRequestExecutionStatusCutoverMigration(pool);
  // Issue #243: graphile-worker's own schema doesn't exist until ensureQueueSchema creates it, so
  // semprec_side's grants on it can't live in the SQL migrations above — this CLI is the real-deploy
  // invocation point, matching testSupport/globalSetup.ts's test-time call to the same two functions.
  await ensureQueueSchema(pool);
  await grantQueueSchemaPrivileges(pool);
  // Issue #222: needs graphile_worker's own schema/functions, which don't exist until the two
  // calls above create them — unlike the cutover migrations above, which run before them.
  await runHeartbeatFireQueueSplitMigration(pool);
} finally {
  await pool.end();
}
