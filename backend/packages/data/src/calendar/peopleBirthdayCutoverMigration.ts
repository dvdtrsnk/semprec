import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { PEOPLE_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/**
 * The two birthday properties of a person (issue #1795), mirroring the People property list in
 * `seedTenDatabases.ts` (names are NULL there too; labels come from the seed i18n).
 */
const BIRTHDAY_PROPERTIES = [
  { key: "birthday", type: "date" },
  { key: "birthdayYearKnown", type: "checkbox" },
] as const;

/**
 * Populated-upgrade cutover for issue #1795: adds `birthday` and `birthdayYearKnown`, both owned by the user,
 * to a People database seeded by an older build. The People schema is locked once seeded, so only this
 * code-level migration (direct SQL) may change it. Idempotent (inserts only absent keys and leaves existing
 * properties and items untouched) and a no-op when the tenant has no People database, where the seed creates
 * the target shape.
 *
 * Runs once per tenant, in that tenant's scope, via `runTenantCutoverMigrations`.
 */
export async function runPeopleBirthdayCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const people = await getDatabaseByModuleId(client, PEOPLE_MODULE_ID);
    if (!people) return;

    // Excludes concurrent writers to the properties for the duration of the cutover, so the absent-key check
    // below and the inserts cannot interleave with another schema write. Plain reads are not excluded; both
    // properties become visible together when this transaction commits.
    await client.query(`LOCK TABLE properties IN EXCLUSIVE MODE`);

    const { rows } = await client.query<{ key: string }>(`SELECT key FROM properties WHERE database_id = $1`, [
      people.id,
    ]);
    const existing = new Set(rows.map((row) => row.key));
    for (const property of BIRTHDAY_PROPERTIES) {
      if (existing.has(property.key)) continue;
      await client.query(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         VALUES ($1, $2, NULL, $3, '{}'::jsonb, false, 'user', NULL)`,
        [people.id, property.key, property.type],
      );
    }
  });
}
