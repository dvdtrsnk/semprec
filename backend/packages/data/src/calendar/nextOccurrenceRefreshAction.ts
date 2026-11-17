// Moves the stored `nextOccurrenceDate` of recurring Events on as days pass; writes use
// `nextOccurrenceDateTransform.ts`.
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

/** Runs in the tenant's system time zone. */
export const NEXT_OCCURRENCE_REFRESH_HEARTBEAT = {
  name: "Refresh next occurrence of recurring events",
  rule: { kind: "dailyTime", at: "00:05" },
} as const;

const configSchema = z.object({ eventsDatabaseId: z.uuid() });

const BATCH_SIZE = 200;

/** Days are compared as "C"-collated text, never cast, so an unreadable stored value cannot fail the statement. */
async function lockStaleBatch(
  client: PoolClient,
  eventsDatabaseId: string,
  today: string,
  afterId: string | null,
): Promise<StoredRow[]> {
  const { rows } = await client.query<StoredRow>(
    `SELECT id, properties, updated_at, version FROM items
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
 * Batches are locked first, so each value is computed on the row an update would see. A failed write rolls back
 * only its batch; the next run continues from the Events still stale.
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
