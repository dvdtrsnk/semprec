import type { Pool } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { withTransaction } from "../db/pool.js";
import { createHeartbeat } from "../scheduler/schedulerStore.js";
import { CALENDARS_MODULE_ID } from "../seed/calendarsKeys.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone } from "../timezone.js";
import { computeNextOccurrenceDates, NEXT_OCCURRENCE_DATE_PROPERTY_KEY } from "./nextOccurrenceDate.js";
import { NEXT_OCCURRENCE_REFRESH_ACTION_ID, NEXT_OCCURRENCE_REFRESH_HEARTBEAT } from "./nextOccurrenceRefreshAction.js";
import type { StoredRow } from "./timelineRead.js";

/** Events backfilled per transaction. */
const BACKFILL_BATCH_SIZE = 500;

/**
 * Populated-upgrade cutover for issue gh-1905, in three steps:
 *
 * 1. In one transaction under `LOCK TABLE properties IN EXCLUSIVE MODE` it inserts the `nextOccurrenceDate`
 *    definition into the tenant's Events database when absent, the one `seedTenDatabases.ts` declares (type `date`,
 *    system-owned, locked, no name, empty config, no owner process). The schema is `schema_locked`, so direct SQL is
 *    the only way in.
 * 2. It gives every Event without the key, trashed ones included, the value `computeNextOccurrenceDates` computes on
 *    the day of the run in the tenant's time zone, by direct SQL in batches of 500 Events with one transaction each,
 *    paged by id, so an Event that has no day (and gets no value) is not read twice. `updated_at` is not changed: the
 *    value is system-derived, and moving the version would turn clients' next writes into conflicts. An Event that
 *    already has the key, one the Events transform wrote, keeps it.
 * 3. In one transaction under a share-row-exclusive lock on `project_heartbeats` it creates the daily
 *    `calendar.refreshNextOccurrence` heartbeat on the calendar module's system project, the owner project of the
 *    Calendars database, unless the tenant has one. The fresh seed (`seedCalendarsInTransaction`), which the calendars
 *    cutover also runs for a tenant without a Calendars database, creates the same heartbeat, so then this step
 *    finds it.
 *
 * Idempotent and resumable. A tenant without an Events database is skipped entirely. Runs once per tenant, in that
 * tenant's scope and under row-level security, via `runTenantCutoverMigrations`, after the calendars cutover.
 */
export async function runNextOccurrenceDateCutoverMigration(pool: Pool): Promise<void> {
  const eventsDatabaseId = await withTransaction(pool, async (client) => {
    const events = await getDatabaseByModuleId(client, EVENTS_MODULE_ID);
    if (!events) return null;
    await client.query("LOCK TABLE properties IN EXCLUSIVE MODE");
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
      [events.id, NEXT_OCCURRENCE_DATE_PROPERTY_KEY],
    );
    if (rows.length === 0) {
      await client.query(
        `INSERT INTO properties (database_id, key, name, type, config, locked, owner, owner_process)
         VALUES ($1, $2, NULL, 'date', '{}'::jsonb, true, 'system', NULL)`,
        [events.id, NEXT_OCCURRENCE_DATE_PROPERTY_KEY],
      );
    }
    return events.id;
  });
  if (eventsDatabaseId === null) return;

  let afterId: string | null = null;
  for (;;) {
    const batch: StoredRow[] = await withTransaction(pool, async (client) => {
      const zone = await getSystemTimezone(client);
      assertValidTimezone(zone);
      const { rows } = await client.query<StoredRow>(
        `SELECT id, properties, updated_at FROM items
          WHERE database_id = $1 AND NOT (properties ? $2) AND ($3::uuid IS NULL OR id > $3::uuid)
          ORDER BY id LIMIT $4 FOR UPDATE`,
        [eventsDatabaseId, NEXT_OCCURRENCE_DATE_PROPERTY_KEY, afterId, BACKFILL_BATCH_SIZE],
      );
      const now = new Date();
      const values = await computeNextOccurrenceDates({ client, eventsDatabaseId, rows }, now, zone);
      const valued = rows.flatMap((row) => {
        const value = values.get(row.id) ?? null;
        return value === null ? [] : [{ id: row.id, value }];
      });
      if (valued.length > 0) {
        const result = await client.query(
          `UPDATE items
              SET properties = items.properties || jsonb_build_object($3::text, v.value)
             FROM unnest($2::uuid[], $4::text[]) AS v(id, value)
            WHERE items.database_id = $1 AND items.id = v.id`,
          [
            eventsDatabaseId,
            valued.map((row) => row.id),
            NEXT_OCCURRENCE_DATE_PROPERTY_KEY,
            valued.map((row) => row.value),
          ],
        );
        // The rows were locked by the select above, so every one of them must have been updated.
        if (result.rowCount !== valued.length) {
          throw new Error(`Backfilled ${result.rowCount ?? 0} of ${valued.length} Events with a next occurrence date`);
        }
      }
      return rows;
    });
    if (batch.length < BACKFILL_BATCH_SIZE) break;
    afterId = batch[batch.length - 1]!.id;
  }

  await withTransaction(pool, async (client) => {
    // Serializes two concurrent runs, so neither sees the other's heartbeat missing and both insert it.
    await client.query("LOCK TABLE project_heartbeats IN SHARE ROW EXCLUSIVE MODE");
    const existing = await client.query("SELECT 1 FROM project_heartbeats WHERE action_id = $1", [
      NEXT_OCCURRENCE_REFRESH_ACTION_ID,
    ]);
    if ((existing.rowCount ?? 0) > 0) return;
    const calendars = await getDatabaseByModuleId(client, CALENDARS_MODULE_ID);
    const projectItemId = calendars?.ownerProjectItemId ?? null;
    if (projectItemId === null) return;
    await createHeartbeat(client, {
      projectItemId,
      ...NEXT_OCCURRENCE_REFRESH_HEARTBEAT,
      actionId: NEXT_OCCURRENCE_REFRESH_ACTION_ID,
      actionConfig: { eventsDatabaseId },
    });
  });
}
