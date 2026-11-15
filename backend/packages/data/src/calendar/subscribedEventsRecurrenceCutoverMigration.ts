import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { SUBSCRIBED_EVENTS_MODULE_ID } from "../seed/calendarsKeys.js";
import { SUBSCRIBED_EVENT_RECURRENCE_KEYS } from "../seed/seedSubscribedEvents.js";
import { lockTenantSeedInTransaction } from "../seed/seedSystem.js";
import { CALENDAR_MODULE_ID } from "./calendarModuleId.js";

/**
 * Populated-upgrade cutover for issue gh-1966: gives a tenant's `subscribedEvents` database the three system-owned
 * recurrence properties `recurrenceRule`, `exceptionDates` and `recurrenceId` (text, empty config, not locked, no name,
 * owner process `calendar`), the definitions `seed/seedSubscribedEvents.ts` declares for a fresh tenant. The schema is
 * `schema_locked`, so direct SQL is the only way in, in one transaction under `LOCK TABLE properties IN EXCLUSIVE MODE`
 * (the pattern of `calendar/eventsRecurrenceCutoverMigration.ts`), after the tenant's structural seed lock that
 * `subscribedEventsCutoverMigration.ts` also takes. No row is touched: a row without the keys is no series and no
 * override.
 *
 * A tenant that gets the database from `runSubscribedEventsCutoverMigration` in the same run already has the
 * properties, since that step creates them through the seed. Idempotent per key: a property that exists is left as it is.
 * A tenant without a `subscribedEvents` database is skipped. Runs once per tenant, in that tenant's scope and under
 * row-level security, via `runTenantCutoverMigrations`.
 */
export async function runSubscribedEventsRecurrenceCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockTenantSeedInTransaction(client, "runSubscribedEventsRecurrenceCutoverMigration");
    const database = await getDatabaseByModuleId(client, SUBSCRIBED_EVENTS_MODULE_ID);
    if (!database) return;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    for (const key of SUBSCRIBED_EVENT_RECURRENCE_KEYS) {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
        [database.id, key],
      );
      if (rows.length > 0) continue;
      await client.query(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         VALUES ($1, $2, NULL, 'text', '{}'::jsonb, false, 'system', $3)`,
        [database.id, key, CALENDAR_MODULE_ID],
      );
    }
  });
}
