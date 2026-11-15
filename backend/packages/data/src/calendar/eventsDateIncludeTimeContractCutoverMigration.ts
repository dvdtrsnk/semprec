import type { Pool } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

const dateProperty = z.object({ id: z.string(), config: z.record(z.string(), z.unknown()) });

/**
 * Contract-step cutover for issue gh-1971: removes the `includeTime` key from the config of the Events `date`
 * property of a tenant whose Events database was seeded before `seedTenDatabases.ts` stopped declaring it. Since the
 * data migration of gh-1797 an Event's `date` is a calendar date and its time lives in `timeFrom` and `timeTo`, so the
 * flag only misleads the clients that read the schema projection. Every other config key of the property is kept, and
 * no other database's `date` property is touched. The Events schema is locked once seeded, so only this code-level
 * migration (direct SQL) may change it.
 *
 * One transaction reads the property under a row lock and writes it only when the key is there, so the write acts on
 * the config it read. A tenant without an Events database or without the property, a property that has no
 * `includeTime` and a second run all change nothing, and none of them is a failure.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via `runTenantCutoverMigrations`.
 */
export async function runEventsDateIncludeTimeContractCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (!events) return; // not seeded yet; the fresh-install seed ships the target shape
    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT id, config FROM properties WHERE database_id = $1 AND key = 'date' FOR UPDATE`,
      [events.id],
    );
    const row = rows[0];
    if (!row) return;
    const property = dateProperty.parse(row);
    if (!Object.hasOwn(property.config, "includeTime")) return;
    const result = await client.query(`UPDATE properties SET config = config - 'includeTime' WHERE id = $1`, [
      property.id,
    ]);
    requireAffectedRows(result, "Events date property includeTime removal");
  });
}
