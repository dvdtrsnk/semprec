import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { RECIPES_MODULE_ID, RECIPE_SOURCE_URL_KEY } from "../seed/recipesModuleKeys.js";

/**
 * Populated-upgrade cutover for issue gh-1974: gives a tenant's Recipes database the user-owned `sourceUrl` property,
 * the definition `seed/seedRecipesModule.ts` declares (type `url`, empty config, not locked, no name, no owner
 * process). The schema is `schema_locked`, so direct SQL is the only way in, in one transaction under
 * `LOCK TABLE properties IN EXCLUSIVE MODE` (the pattern of `calendar/calendarSubscriptionUrlCutoverMigration.ts`). No
 * recipe is touched: a recipe without the key has no source.
 *
 * Idempotent: a tenant whose Recipes database already has a property with the key is left as it is. A tenant without a
 * Recipes database is skipped: `runRecipesModuleCutoverMigration` creates the database with this property when it runs
 * for the tenant, and `seedSystem` does the same for a new one. Runs once per tenant, in that tenant's scope and under
 * row-level security, for suspended tenants too, via `runTenantCutoverMigrations`.
 */
export async function runRecipesSourceUrlCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const recipes = await getDatabaseByModuleId(client, RECIPES_MODULE_ID);
    if (!recipes) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
      [recipes.id, RECIPE_SOURCE_URL_KEY],
    );
    if (rows.length > 0) return;
    await client.query(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, $2, NULL, 'url', '{}'::jsonb, false, 'user', NULL)`,
      [recipes.id, RECIPE_SOURCE_URL_KEY],
    );
  });
}
