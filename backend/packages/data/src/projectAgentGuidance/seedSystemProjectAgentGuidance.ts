import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS } from "../seed/systemProjectAgentGuidance.js";
import { logger } from "../tenancy/logger.js";
import { seedProjectAgentGuidanceFromLegacyText } from "./legacyAgentsConversion.js";

/**
 * Gives the system projects of one tenant their guidance rows, owned by `userId` (issue #1449). A system project is
 * resolved from the system database it owns, by that database's stable `owner_module_id`, never by its name, so a
 * renamed system project still gets its text. A project that is missing, deleted or not `systemActive` gets none, and
 * so does a module whose system database is absent. Idempotent: an existing row is left as it is.
 *
 * Runs in the caller's tenant scope, on the caller's transaction.
 */
export async function seedSystemProjectAgentGuidance(client: PoolClient, userId: string): Promise<void> {
  const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
  if (!projects) return;

  for (const [ownerModuleId, text] of Object.entries(SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS)) {
    const systemDatabase = await getDatabaseByModuleId(client, ownerModuleId);
    if (!systemDatabase?.ownerProjectItemId) continue;
    const project = await getItemById(client, projects.id, systemDatabase.ownerProjectItemId);
    if (!project || project.deletedAt !== null || project.properties.systemActive !== true) continue;
    await seedProjectAgentGuidanceFromLegacyText(client, { projectItemId: project.id, ownerUserId: userId, text });
  }
}

/**
 * Runs `seedSystemProjectAgentGuidance` for an account that was just created in `tenantId`, after that account's
 * own transaction committed. The callers create accounts under the system scope (`runAsSystem`), whose transactions
 * see a tenant's rows as absent under row-level security, so the seeding enters the tenant's scope itself. A failure
 * is logged with the tenant id only and rethrown: the account exists by then, and the failure must not be reported as
 * success.
 */
export async function seedAccountSystemProjectGuidance(pool: Pool, tenantId: string, userId: string): Promise<void> {
  try {
    await runInTenant(tenantId, () =>
      withTransaction(pool, (client) => seedSystemProjectAgentGuidance(client, userId)),
    );
  } catch (err) {
    logger.error({ tenantId }, "project_guidance_seeding_failed");
    throw err;
  }
}
