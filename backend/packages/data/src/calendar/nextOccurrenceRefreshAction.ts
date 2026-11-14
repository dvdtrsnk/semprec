// The daily heartbeat action that moves the stored `nextOccurrenceDate` of recurring Events on as days pass (issue
// gh-1905). The inline computation on a write is `nextOccurrenceDateTransform.ts`.
// Constrained by: docs/adr/2026-11-14-the-next-occurrence-date-of-an-event-is-a-stored-system-property.md,
// docs/adr/2026-09-10-choke-point-api-for-state-writes.md
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import type { ActionHandler } from "../scheduler/actions.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone } from "../timezone.js";
import { calendarDayIn, computeNextOccurrenceDates, NEXT_OCCURRENCE_DATE_PROPERTY_KEY } from "./nextOccurrenceDate.js";
import type { StoredRow } from "./timelineRead.js";

export const NEXT_OCCURRENCE_REFRESH_ACTION_ID = "calendar.refreshNextOccurrence";

/**
 * The refresh's heartbeat, shared by `seedCalendarsInTransaction` (fresh install) and
 * `runNextOccurrenceDateCutoverMigration` (populated upgrade) so both create the same one: five minutes after midnight
 * in the tenant's system time zone.
 */
export const NEXT_OCCURRENCE_REFRESH_HEARTBEAT = {
  name: "Refresh next occurrence of recurring events",
  rule: { kind: "dailyTime", at: "00:05" },
} as const;

/** The heartbeat's `action_config`: the Events database it refreshes, resolved once at seed time. */
const configSchema = z.object({ eventsDatabaseId: z.uuid() });

/** Events one transaction refreshes. */
const BATCH_SIZE = 200;

/**
 * The next batch of live recurring Events after `afterId` whose stored `nextOccurrenceDate` is a day before `today`,
 * locked until the transaction ends. A stored value that is not text, or a row without one, is not stale. Days are
 * compared as text in the "C" collation, never cast, so an unreadable stored value cannot fail the statement.
 */
async function lockStaleBatch(
  client: PoolClient,
  eventsDatabaseId: string,
  today: string,
  afterId: string | null,
): Promise<StoredRow[]> {
  const { rows } = await client.query<StoredRow>(
    `SELECT id, properties, updated_at FROM items
      WHERE database_id = $1 AND deleted_at IS NULL
        AND jsonb_typeof(properties->'recurrence') = 'object'
        AND properties->'seriesId' IS NULL
        AND jsonb_typeof(properties->'nextOccurrenceDate') = 'string'
        AND left(properties->>'nextOccurrenceDate', 10) COLLATE "C" < $2
        AND ($3::uuid IS NULL OR id > $3::uuid)
      ORDER BY id LIMIT $4 FOR UPDATE`,
    [eventsDatabaseId, today, afterId, BATCH_SIZE],
  );
  return rows;
}

/**
 * Registered as the `dailyTime` heartbeat action `calendar.refreshNextOccurrence`: recomputes `nextOccurrenceDate` for
 * every live recurring Event of the tenant whose stored value is before today in the tenant's system time zone, in
 * batches of `BATCH_SIZE` Events per transaction, paged by id. The rows of a batch are locked first, so the value is
 * computed on the row an update would see. Each new value is written through `updateItemWithClient` by the system
 * writer, with the system-owned key allowed; an Event whose stored value is current is not read at all. The values of a
 * batch come from one timeline expansion (`computeNextOccurrenceDates`), so a cancelled or moved occurrence is not named.
 *
 * Runs in the firing heartbeat's tenant. A failure of one write ends the run and rolls back its batch; batches
 * that committed stay, and the next run continues from the Events that are still stale.
 */
export function createNextOccurrenceRefreshAction(pool: Pool): ActionHandler {
  return async (actionConfig) => {
    const { eventsDatabaseId } = configSchema.parse(actionConfig);
    const now = new Date();
    const today = await withTransaction(pool, async (client) => {
      const zone = await getSystemTimezone(client);
      assertValidTimezone(zone);
      return { zone, day: calendarDayIn(now, zone) };
    });

    let afterId: string | null = null;
    for (;;) {
      const batch: StoredRow[] = await withTransaction(pool, async (client) => {
        const rows = await lockStaleBatch(client, eventsDatabaseId, today.day, afterId);
        const values = await computeNextOccurrenceDates({ client, eventsDatabaseId, rows }, now, today.zone);
        for (const row of rows) {
          const value = values.get(row.id) ?? null;
          await updateItemWithClient(
            client,
            {
              databaseId: eventsDatabaseId,
              itemId: row.id,
              propertiesPatch: { [NEXT_OCCURRENCE_DATE_PROPERTY_KEY]: value },
            },
            { allowedSystemKeys: [NEXT_OCCURRENCE_DATE_PROPERTY_KEY] },
          );
        }
        return rows;
      });
      if (batch.length < BATCH_SIZE) return;
      afterId = batch[batch.length - 1]!.id;
    }
  };
}
