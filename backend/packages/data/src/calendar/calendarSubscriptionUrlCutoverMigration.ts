import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { CALENDAR_SUBSCRIPTION_URL_KEY } from "./calendarSubscriptionUrlTransform.js";

/**
 * Populated-upgrade cutover for issue gh-1925: gives a tenant's Calendars database the user-owned
 * `subscriptionUrl` property, the definition `seed/seedCalendars.ts` declares (type `url`, empty config, not
 * locked, no name, no owner process). The schema is `schema_locked`, so direct SQL is the only way in, in one
 * transaction under `LOCK TABLE properties IN EXCLUSIVE MODE` (the pattern of
 * `transcription/transcriptsCatalogCutoverMigration.ts`). No calendar row is touched: a calendar without the key
 * has no address.
 *
 * Idempotent: a tenant whose Calendars database already has a property with the key is left as it is. A tenant
 * without a Calendars database is skipped. Runs once per tenant, in that tenant's scope and under row-level
 * security, for suspended tenants too, via `runTenantCutoverMigrations`.
 */
export async function runCalendarSubscriptionUrlCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const calendars = await getDatabaseByModuleId(client, CALENDARS_MODULE_ID);
    if (!calendars) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
      [calendars.id, CALENDAR_SUBSCRIPTION_URL_KEY],
    );
    if (rows.length > 0) return;
    await client.query(
      `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
       VALUES ($1, $2, NULL, 'url', '{}'::jsonb, false, 'user', NULL)`,
      [calendars.id, CALENDAR_SUBSCRIPTION_URL_KEY],
    );
  });
}
