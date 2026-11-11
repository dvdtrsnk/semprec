import type { Pool } from "pg";
import { getTenantUserId } from "../auth/usersStore.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { seedProjectAgentGuidanceFromLegacyText } from "../projectAgentGuidance/legacyAgentsConversion.js";
import { RECIPES_MODULE_ID } from "../seed/recipesModuleKeys.js";
import { seedRecipesModuleInTransaction } from "../seed/seedRecipesModule.js";
import { lockTenantSeedInTransaction } from "../seed/seedSystem.js";
import { SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS } from "../seed/systemProjectAgentGuidance.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * Populated-upgrade cutover for issue #1707: gives a tenant that was seeded before the Recipes module its
 * `recipes` database, through the same `seedRecipesModuleInTransaction` the fresh seed calls.
 *
 * One transaction. It takes the tenant's structural seed lock and admits the tenant
 * (`lockTenantSeedInTransaction`, the lock and order `seedSystem` uses) before it checks whether the database
 * exists. `seedSystem` and this cutover create the database only while they hold that lock, so of two cutovers
 * of one tenant the second waits and then finds the database the first created. A tenant that has the database
 * is left as it is, which makes a second run write nothing. A tenant without a Projects database has not been
 * seeded yet and is skipped: `seedSystem` creates Recipes together with the rest.
 *
 * When the tenant has an account, the same transaction also writes the `project_agent_guidance` row of the new
 * Recipes project, with its drift heartbeat, from the project's seed text and owned by the tenant's user. The
 * guidance cutover (`runProjectAgentGuidanceCutoverMigration`) is registered before this step and has already
 * passed the tenant's projects by then, so without this write the project would have no guidance until the
 * next deploy. A tenant without an account gets the row when its account is created, like every system project
 * (`seedSystemProjectAgentGuidance`).
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via `runTenantCutoverMigrations`.
 */
export async function runRecipesModuleCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockTenantSeedInTransaction(client, "runRecipesModuleCutoverMigration");
    if (await getDatabaseByModuleId(client, RECIPES_MODULE_ID)) return;
    const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!projects) return;
    // `gallery` is a built-in view type, so an empty registry knows it.
    const { projectItemId } = await seedRecipesModuleInTransaction(client, projects.id, createViewTypeRegistry());
    const ownerUserId = await getTenantUserId(client);
    if (ownerUserId === null) return;
    await seedProjectAgentGuidanceFromLegacyText(client, {
      projectItemId,
      ownerUserId,
      text: SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS[RECIPES_MODULE_ID],
    });
  });
}
