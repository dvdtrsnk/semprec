import { ensureQueueSchema, grantQueueSchemaPrivileges } from "@semprec/queue";
import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { createPool } from "./pool.js";
import { logger } from "./logger.js";
import { runMigrations } from "./migrate.js";
import { runDocHistoryCutoverMigration } from "../docs/docHistoryCutoverMigration.js";
import { runAgentRunsActorUserIdCutoverMigration } from "../agentRuns/agentRunsActorUserIdCutoverMigration.js";
import { runApprovalRequestExecutionStatusCutoverMigration } from "../mcp/approvalRequestExecutionStatusCutoverMigration.js";
import { runHeartbeatFireQueueSplitMigration } from "../scheduler/heartbeatFireQueueSplitMigration.js";
import { runTenantCutoverMigrations } from "./tenantCutoverMigrations.js";
import { activateCzechHunspellSearch } from "../mail/czechHunspellSearch.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

// Cutover migrations are not bounded by the runtime statement timeout.
const pool = createPool(connectionString, { statementTimeoutMs: 0 });
// The per-tenant cutovers run under row-level security, which the owner pool above bypasses.
const tenantPool = createPool(connectionString, { statementTimeoutMs: 0, role: "semprec_data" });

async function endPool(target: Pool, name: string): Promise<void> {
  try {
    await target.end();
  } catch (err) {
    logger.error({ err, pool: name }, "Failed to end a migration pool");
  }
}

try {
  await runAsSystem("deploy migrations", async () => {
    await runMigrations(pool);
    // Issue #207: upgrades a database migrated before provisioning installed the Czech Hunspell
    // assets; a no-op once active, and keeps the fallback while the assets are still missing.
    await activateCzechHunspellSearch(pool);
    await runDocHistoryCutoverMigration(pool);
    await runAgentRunsActorUserIdCutoverMigration(pool);
    await runApprovalRequestExecutionStatusCutoverMigration(pool);
    await runTenantCutoverMigrations(tenantPool);
    // Issue #243: graphile-worker's own schema doesn't exist until ensureQueueSchema creates it, so
    // semprec_side's grants on it can't live in the SQL migrations above — this CLI is the real-deploy
    // invocation point, matching testSupport/globalSetup.ts's test-time call to the same two functions.
    await ensureQueueSchema(pool);
    await grantQueueSchemaPrivileges(pool);
    // Issue #222: needs graphile_worker's own schema/functions, which don't exist until the two
    // calls above create them — unlike the cutover migrations above, which run before them.
    await runHeartbeatFireQueueSplitMigration(pool);
  });
} finally {
  await endPool(pool, "owner");
  await endPool(tenantPool, "tenant");
}
