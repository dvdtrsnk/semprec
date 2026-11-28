import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@alldots/shared";
import { withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS } from "../seed/systemProjectAgentGuidance.js";
import { logger } from "../tenancy/logger.js";
import { seedProjectAgentGuidanceFromLegacyText } from "./legacyAgentsConversion.js";

/**
 * Seeds guidance for the tenant's system projects, owned by `userId`. A system project is found via its system
 * database's stable `owner_module_id` (never by name, so renames are fine); missing, deleted or inactive projects are
 * skipped. Idempotent. Runs in the caller's tenant scope and transaction.
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
 * Runs after the new account's transaction committed. Account creation runs under `runAsSystem`, which sees tenant
 * rows as absent under RLS, so this enters the tenant scope itself. Failures are logged (tenant id only) and
 * rethrown: the account exists, but the failure must not read as success.
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
