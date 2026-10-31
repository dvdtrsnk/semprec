import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { getTenantUserId } from "../auth/usersStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getAllItemsInDatabase } from "../chokePoint/itemsStore.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { seedProjectAgentGuidanceFromLegacyText } from "./legacyAgentsConversion.js";

/**
 * Populated-upgrade cutover for issue #1449: moves each project's legacy `agents` text into its
 * `project_agent_guidance` row, the single source the agent reads. Runs once per tenant, in that tenant's scope,
 * via `runTenantCutoverMigrations`, and is idempotent: a row that exists is never changed.
 *
 * A tenant without a user writes nothing (its rows are seeded when its account is created), and so does a tenant
 * without a Projects database. Deleted Projects items and blank `agents` values are skipped. The whole tenant is one
 * transaction, so a failure leaves the tenant without partial rows and the deploy reports it.
 */
export async function runProjectAgentGuidanceCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const ownerUserId = await getTenantUserId(client);
    if (ownerUserId === null) return;
    const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!projects) return;

    for (const item of await getAllItemsInDatabase(client, projects.id)) {
      if (item.deletedAt !== null) continue;
      const text = item.properties.agents;
      if (typeof text !== "string" || text.trim() === "") continue;
      await seedProjectAgentGuidanceFromLegacyText(client, { projectItemId: item.id, ownerUserId, text });
    }
  });
}
