import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { CALENDARS_MODULE_ID, SUBSCRIBED_EVENTS_MODULE_ID } from "../seed/calendarsKeys.js";
import { seedSubscribedEventsInTransaction } from "../seed/seedSubscribedEvents.js";
import { lockTenantSeedInTransaction } from "../seed/seedSystem.js";

/**
 * Populated-upgrade cutover for issue gh-1962: creates the `subscribedEvents` system database, its
 * system-owned properties and the `Calendars.subscribedEvents` / `SubscribedEvents.calendar` relation for a
 * tenant whose Calendars database was seeded before it, through the same `seedSubscribedEventsInTransaction`
 * the fresh seed calls. The Calendars schema is locked, so only this code-level migration may add the
 * relation property to it.
 *
 * One transaction takes the tenant's structural seed lock (the lock and tenant admission `seedSystem` and
 * the calendars cutover use) before it checks anything, so two runs, or a run and a seed, serialize. A tenant
 * without a Calendars database is skipped: it gets the database from `runCalendarsCutoverMigration`, or from
 * the seed. Idempotent: a tenant that has the database gets no change.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via
 * `runTenantCutoverMigrations`.
 */
export async function runSubscribedEventsCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await lockTenantSeedInTransaction(client, "runSubscribedEventsCutoverMigration");
    const calendars = await getDatabaseByModuleId(client, CALENDARS_MODULE_ID);
    if (!calendars) return;
    if (await getDatabaseByModuleId(client, SUBSCRIBED_EVENTS_MODULE_ID)) return;
    await seedSubscribedEventsInTransaction(client, calendars);
  });
}
