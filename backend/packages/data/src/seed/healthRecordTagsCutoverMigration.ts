import type { Pool } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { HEALTH_RECORDS_MODULE_ID } from "./tenDatabaseKeys.js";

/** The Health records `tags` options added by issue #1700, in the order `seedTenDatabases.ts` lists them. */
const addedKeys = ["bloodPressure", "prevention"];

/**
 * Populated-upgrade cutover for issue #1700: appends the `bloodPressure` and `prevention` options to the
 * `tags` property of the current tenant's Health records database. That database is schema-locked and an
 * already seeded tenant is not seeded again, so the options `seedTenDatabases.ts` now declares reach an
 * existing tenant through this step alone.
 *
 * Every stored option object keeps its content and position; a key that is already stored is not appended
 * again, and the row is written only when at least one key was missing. Does nothing when the tenant has no
 * Health records database, or when that database has no `tags` property.
 *
 * `runTenantCutoverMigrations` calls it for each maintained tenant, inside that tenant's scope.
 */
export async function runHealthRecordTagsCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const healthRecords = await getDatabaseByModuleId(client, HEALTH_RECORDS_MODULE_ID);
    if (!healthRecords) return;
    // Held until the transaction ends, so no other run and no property write can change `tags` between
    // the read below and the UPDATE.
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<Record<string, unknown>>(
      "SELECT id, config FROM properties WHERE database_id = $1 AND key = 'tags'",
      [healthRecords.id],
    );
    if (!rows[0]) return;
    const property = z
      .object({
        id: z.string(),
        config: z.object({ options: z.array(z.object({ key: z.string() }).passthrough()).optional() }).passthrough(),
      })
      .parse(rows[0]);
    const options = property.config.options ?? [];
    const missing = addedKeys.filter((key) => !options.some((option) => option.key === key));
    if (missing.length === 0) return;
    const result = await client.query(
      "UPDATE properties SET config = jsonb_set(config, '{options}', $2::jsonb) WHERE id = $1",
      [property.id, JSON.stringify([...options, ...missing.map((key) => ({ key }))])],
    );
    requireAffectedRows(result, "properties.healthRecords.tags option backfill");
  });
}
