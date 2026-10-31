import type { Pool } from "pg";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";

const ADDED_OPTION_KEYS = ["png", "heic", "audio"];

/**
 * Populated-upgrade cutover for the Files `type` select (issue #1410): appends the `png`, `heic`
 * and `audio` options that `seedTenDatabases.ts` now declares for fresh installs. The Files
 * schema is locked once seeded, so only this code-level migration may change it. Idempotent
 * (adds only absent keys) and a no-op when the tenant has no Files database yet.
 *
 * Runs once per tenant, in that tenant's scope, via `runTenantCutoverMigrations`.
 */
export async function runFilesTypeOptionsCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const files = await getDatabaseByModuleId(client, FILES_MODULE_ID);
    if (!files) return; // fresh install: the seed creates the target shape

    await client.query(`LOCK TABLE properties IN EXCLUSIVE MODE`);

    const { rows } = await client.query<{ id: string; config: { options?: { key: string }[] } }>(
      `SELECT id, config FROM properties WHERE database_id = $1 AND key = 'type'`,
      [files.id],
    );
    const typeProperty = rows[0];
    if (!typeProperty) return;
    const options = typeProperty.config.options ?? [];
    const missing = ADDED_OPTION_KEYS.filter((key) => !options.some((option) => option.key === key));
    if (missing.length === 0) return;
    const result = await client.query(
      `UPDATE properties SET config = jsonb_set(config, '{options}', $2::jsonb) WHERE id = $1`,
      [typeProperty.id, JSON.stringify([...options, ...missing.map((key) => ({ key }))])],
    );
    requireAffectedRows(result, "properties.files.type option backfill");
  });
}
