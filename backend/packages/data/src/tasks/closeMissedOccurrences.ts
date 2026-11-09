import type { PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { createItemWithClient, rolloverTaskWithClient } from "../chokePoint/itemWrites.js";
import { lockItemByIdNowait } from "../chokePoint/itemsStore.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { firstOccurrenceAfter, latestOccurrenceOnOrBefore } from "./nextDueDate.js";
import { getTaskRecurrenceBySeriesId, moveTaskRecurrenceToItem } from "./taskRecurrenceStore.js";

export async function closeMissedOccurrence(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  today: string,
): Promise<void> {
  const current = await client.query<{ properties: Record<string, unknown> }>(
    "SELECT properties FROM items WHERE database_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE",
    [databaseId, itemId],
  );
  const properties = current.rows[0]?.properties;
  if (
    !properties ||
    properties.status !== "notDone" ||
    typeof properties.seriesId !== "string" ||
    typeof properties.occurrenceDate !== "string" ||
    properties.occurrenceDate >= today
  )
    return;
  const series = await getTaskRecurrenceBySeriesId(client, properties.seriesId, true);
  if (!series?.active || !series.anchorDate || !series.template) return;
  const next = firstOccurrenceAfter(
    series.rule,
    properties.occurrenceDate,
    properties.occurrenceDate,
    series.anchorDate,
  );
  if (next > today) return;
  const latest = latestOccurrenceOnOrBefore(series.rule, series.anchorDate, today);
  if (!latest) return;
  const found = await client.query<{ id: string }>(
    `SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL
       AND properties->>'seriesId' = $2 AND properties->>'occurrenceDate' = $3 ORDER BY id LIMIT 1`,
    [databaseId, properties.seriesId, latest],
  );
  const existing = found.rows[0] ? await lockItemByIdNowait(client, databaseId, found.rows[0].id) : null;
  if (
    found.rows[0] &&
    (!existing ||
      existing.deletedAt ||
      existing.properties.seriesId !== properties.seriesId ||
      existing.properties.occurrenceDate !== latest)
  ) {
    throw new Error("Latest task occurrence changed during reservation");
  }
  const future = await client.query<{ id: string }>(
    `SELECT id FROM items WHERE database_id = $1 AND id = $2 AND deleted_at IS NULL
       AND properties->>'seriesId' = $3 AND properties->>'occurrenceDate' > $4`,
    [databaseId, series.itemId, properties.seriesId, today],
  );
  await rolloverTaskWithClient(client, { databaseId, itemId, status: "missed" });
  if (existing || future.rows.length > 0) return;
  const template = series.template;
  const previous: unknown = properties.recurrence;
  const preset =
    series.itemId === itemId &&
    typeof previous === "object" &&
    previous !== null &&
    "mode" in previous &&
    previous.mode === series.mode &&
    "rule" in previous &&
    isDeepStrictEqual(previous.rule, series.rule) &&
    "preset" in previous &&
    (previous.preset === "daily" ||
      previous.preset === "weekdays" ||
      previous.preset === "weekly" ||
      previous.preset === "monthly" ||
      previous.preset === "yearly")
      ? previous.preset
      : null;
  const created = await createItemWithClient(
    client,
    {
      databaseId,
      properties: {
        ...(template.name === null ? {} : { name: template.name }),
        timeFrom: template.timeFrom,
        timeTo: template.timeTo,
        notifications: template.notifications,
        flagged: template.flagged,
        description: template.description,
        status: "notDone",
        date: latest,
        seriesId: properties.seriesId,
        occurrenceDate: latest,
        recurrence: { preset, mode: series.mode, rule: series.rule },
      },
    },
    { allowedSystemKeys: ["seriesId", "occurrenceDate", "recurrence"], systemOwnerProcess: TASKS_MODULE_ID },
  );
  await moveTaskRecurrenceToItem(client, properties.seriesId, created.id);
}
