import type { Pool } from "pg";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { TaskRecurrenceMode, TaskRecurrenceRule } from "../tasks/taskRecurrenceRule.js";
import { createTaskRecurrence } from "../tasks/taskRecurrenceStore.js";

/**
 * Turns an existing dated Tasks item into the current occurrence of a new series, the state the recurrence route
 * (#1665, not yet built) will produce: `createTaskRecurrence` stores the series with the item's `date` as anchor and
 * its template fields, and the Tasks module's system write puts `seriesId`, `occurrenceDate` and `recurrence` on the
 * item through the choke point. Returns the new series id.
 */
export async function startTaskSeries(
  pool: Pool,
  input: { databaseId: string; itemId: string; mode: TaskRecurrenceMode; rule: TaskRecurrenceRule; active?: boolean },
): Promise<string> {
  return withTransaction(pool, async (client) => {
    const item = await itemsStore.getItemById(client, input.databaseId, input.itemId);
    const date = item?.properties.date;
    if (!item || typeof date !== "string") throw new Error("startTaskSeries needs a dated Tasks item");
    const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
    const series = await createTaskRecurrence(client, {
      itemId: item.id,
      mode: input.mode,
      rule: input.rule,
      anchorDate: date,
      active: input.active,
      template: {
        name: text(item.properties.name),
        timeFrom: text(item.properties.timeFrom),
        timeTo: text(item.properties.timeTo),
        notifications: item.properties.notifications === true,
        persistent: item.properties.persistent === true,
        flagged: item.properties.flagged === true,
        description: text(item.properties.description),
      },
    });
    if (series.seriesId === null) throw new Error("createTaskRecurrence returned no series");
    await updateItemWithClient(
      client,
      {
        databaseId: input.databaseId,
        itemId: item.id,
        propertiesPatch: {
          seriesId: series.seriesId,
          occurrenceDate: date,
          recurrence: { preset: null, mode: input.mode, rule: input.rule },
        },
      },
      { allowedSystemKeys: ["seriesId", "occurrenceDate", "recurrence"], systemOwnerProcess: TASKS_MODULE_ID },
    );
    return series.seriesId;
  });
}

/**
 * Stores one more occurrence of `seriesId` as a Tasks item through the Tasks module's system write, the shape a
 * materialized occurrence has (#1720, not yet built, materializes them from the timeline). Returns the item id.
 */
export async function createSeriesOccurrence(
  pool: Pool,
  input: { databaseId: string; seriesId: string; occurrenceDate: string; status: string },
): Promise<string> {
  return withTransaction(pool, async (client) => {
    const item = await createItemWithClient(
      client,
      {
        databaseId: input.databaseId,
        properties: {
          name: "Occurrence",
          date: input.occurrenceDate,
          status: input.status,
          seriesId: input.seriesId,
          occurrenceDate: input.occurrenceDate,
        },
      },
      { allowedSystemKeys: ["seriesId", "occurrenceDate"], systemOwnerProcess: TASKS_MODULE_ID },
    );
    return item.id;
  });
}
