import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, withTransaction } from "../db/pool.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { SYSTEM_SETTINGS_MODULE_ID } from "../systemSettings.js";
import {
  SEEDED_DEFAULT_INBOX_TYPES_KEY,
  SEEDED_DEFAULT_INBOX_TYPES_NAME,
  seedDefaultInboxItemTypes,
} from "./defaultInboxTypes.js";

/**
 * Populated-upgrade cutover for the default Inbox item types (issue gh-1977). In one transaction it adds the
 * `seededDefaultInboxTypes` marker property to the System settings database when it is missing, then runs
 * `seedDefaultInboxItemTypes`, which creates the defaults the marker does not list. `seedSystem.ts` declares the same
 * property, with an empty list, for a fresh tenant; keep the two identical.
 *
 * The System settings database is `schema_locked`, so the property is inserted with raw SQL, as
 * `transcription/transcriptsCatalogCutoverMigration.ts` does. `LOCK TABLE properties IN EXCLUSIVE MODE` comes first, so
 * of two runs the second waits and finds the property the first inserted. The settings item gets no value for the
 * property: a missing value is an empty list to the seeding, which writes the value with the keys it creates.
 *
 * The step runs on every deploy and changes nothing once every default is recorded: a type the user deleted or renamed
 * is not restored or changed, and a tenant whose types were all deleted is not seeded again. A tenant without the System
 * settings database is skipped. `runTenantCutoverMigrations` calls it for each maintained tenant, inside that tenant's
 * scope.
 */
export async function runDefaultInboxTypesCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const settings = await getDatabaseByModuleId(client, SYSTEM_SETTINGS_MODULE_ID);
    if (!settings) return;

    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
      [settings.id, SEEDED_DEFAULT_INBOX_TYPES_KEY],
    );
    if (rows.length === 0) {
      const result = await client.query(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         VALUES ($1, $2, $3, 'json', '{}'::jsonb, false, 'system', $4)`,
        [settings.id, SEEDED_DEFAULT_INBOX_TYPES_KEY, SEEDED_DEFAULT_INBOX_TYPES_NAME, INBOX_MODULE_ID],
      );
      requireAffectedRows(result, "properties.seededDefaultInboxTypes insert");
    }

    await seedDefaultInboxItemTypes(client);
  });
}
