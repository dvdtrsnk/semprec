import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { seedCalendarsInTransaction } from "../seed/seedCalendars.js";
import { admitTenantInTransaction, lockTenantSeedInTransaction } from "../seed/seedSystem.js";
import { EVENTS_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/** Edges inserted per transaction. */
const EDGE_BATCH_SIZE = 500;

const relationConfig = z.object({ relationDefinitionId: z.uuid() });

/**
 * The `Calendars.events` relation definition and the default calendar of a tenant whose calendars
 * database already exists (seeded by `seedSystem` or by an earlier run of this cutover).
 */
async function existingCalendars(
  client: PoolClient,
  calendarsDatabaseId: string,
): Promise<{ relationDefinitionId: string; defaultCalendarId: string }> {
  const property = await getPropertyByKey(client, calendarsDatabaseId, "events");
  if (!property) throw new Error("The calendars database has no events relation");
  const { relationDefinitionId } = relationConfig.parse(property.config);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
      WHERE database_id = $1 AND deleted_at IS NULL AND properties->'isDefault' = 'true'::jsonb
      ORDER BY id LIMIT 1`,
    [calendarsDatabaseId],
  );
  const defaultCalendarId = rows[0]?.id;
  if (!defaultCalendarId) throw new Error("The calendars database has no default calendar");
  return { relationDefinitionId, defaultCalendarId };
}

/**
 * Populated-upgrade cutover for issue #1600, after the Events properties cutover of #1416, in bounded
 * transactions (docs/adr/2026-11-07-calendar-cutover-uses-bounded-transactions.md):
 *
 * 1. One schema transaction takes the tenant's structural seed lock and admits the tenant
 *    (`lockTenantSeedInTransaction`, the lock and order `seedSystem` uses) before checking whether the
 *    calendars database exists. When it does not, it creates the database, the `Calendars.events` /
 *    `Events.calendar` relation and the eight calendars through the same `seedCalendarsInTransaction` the
 *    fresh seed calls, and commits. The `properties` table lock that seed takes ends with this transaction.
 * 2. Then each Event without a calendar edge, trashed ones included, gets an edge to the default calendar,
 *    at most 500 per transaction. Each batch re-reads the relation definition and the default calendar,
 *    takes the definition's advisory lock (the lock the `BEFORE INSERT` cardinality trigger of
 *    `0013_relation_cardinality.sql` takes for every edge inserted for it) before its no-edge check,
 *    admits the tenant again, inserts by direct SQL and commits; a concurrent run or edge insert of that
 *    definition waits, then sees the committed edges. An edge delete takes no such lock and does not wait.
 *
 * Idempotent and resumable: the database is created only when absent and an Event that has an edge gets
 * no second one, so an interrupted run leaves valid partial progress that the next run completes, and a
 * run after a complete one writes nothing. A tenant without an Events database is skipped.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via
 * `runTenantCutoverMigrations`.
 */
export async function runCalendarsCutoverMigration(pool: Pool): Promise<void> {
  const target = await withTransaction(pool, async (client) => {
    await lockTenantSeedInTransaction(client, "runCalendarsCutoverMigration");
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (!events) return null;
    const calendars = await getDatabaseByModuleId(client, CALENDARS_MODULE_ID);
    if (calendars) return { eventsDatabaseId: events.id, calendarsDatabaseId: calendars.id };
    const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!projects) throw new Error("Projects database has not been seeded");
    const seeded = await seedCalendarsInTransaction(client, projects.id, events.id);
    return { eventsDatabaseId: events.id, calendarsDatabaseId: seeded.calendars.id };
  });
  if (!target) return;

  for (;;) {
    const inserted = await withTransaction(pool, async (client) => {
      const { relationDefinitionId, defaultCalendarId } = await existingCalendars(client, target.calendarsDatabaseId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [relationDefinitionId]);
      await admitTenantInTransaction(client, "runCalendarsCutoverMigration");
      const result = await client.query(
        `INSERT INTO item_relations (relation_definition_id, item_a, item_b)
         SELECT $1, $2, event.id FROM items event
          WHERE event.database_id = $3
            AND NOT EXISTS (
              SELECT 1 FROM item_relations edge WHERE edge.relation_definition_id = $1 AND edge.item_b = event.id
            )
          ORDER BY event.id
          LIMIT $4`,
        [relationDefinitionId, defaultCalendarId, target.eventsDatabaseId, EDGE_BATCH_SIZE],
      );
      return result.rowCount ?? 0;
    });
    // Zero is the normal outcome once every Event has a calendar, so the count only decides whether to continue.
    if (inserted < EDGE_BATCH_SIZE) return;
  }
}
