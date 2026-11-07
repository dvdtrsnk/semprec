import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { withTransaction } from "../db/pool.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { seedCalendarsInTransaction } from "../seed/seedCalendars.js";
import { EVENTS_MODULE_ID, PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

/** Edges inserted per statement. */
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
 * Populated-upgrade cutover for issue #1600, after the Events properties cutover of #1416. Per tenant
 * and in one transaction: when the tenant has no calendars database, it creates the database, the
 * `Calendars.events` / `Events.calendar` relation and the eight calendars through the same
 * `seedCalendarsInTransaction` the fresh seed calls; then it gives every Event without a calendar edge,
 * trashed ones included, an edge to the default calendar, inserting at most 500 edges per statement by
 * direct SQL. Idempotent: the database is created only when absent and an Event that has an edge gets
 * no second one, so a second run writes nothing. A tenant without an Events database is skipped.
 *
 * Runs once per tenant, in that tenant's scope and under row-level security, via
 * `runTenantCutoverMigrations`.
 */
export async function runCalendarsCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (!events) return;
    const calendars = await getDatabaseByModuleId(client, CALENDARS_MODULE_ID);
    let target: { relationDefinitionId: string; defaultCalendarId: string };
    if (calendars) {
      target = await existingCalendars(client, calendars.id);
    } else {
      const projects = await getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
      if (!projects) throw new Error("Projects database has not been seeded");
      target = await seedCalendarsInTransaction(client, projects.id, events.id);
    }

    for (;;) {
      const result = await client.query(
        `INSERT INTO item_relations (relation_definition_id, item_a, item_b)
         SELECT $1, $2, event.id FROM items event
          WHERE event.database_id = $3
            AND NOT EXISTS (
              SELECT 1 FROM item_relations edge WHERE edge.relation_definition_id = $1 AND edge.item_b = event.id
            )
          ORDER BY event.id
          LIMIT $4`,
        [target.relationDefinitionId, target.defaultCalendarId, events.id, EDGE_BATCH_SIZE],
      );
      // Zero is the normal outcome once every Event has a calendar, so the count only decides whether to continue.
      if ((result.rowCount ?? 0) < EDGE_BATCH_SIZE) return;
    }
  });
}
