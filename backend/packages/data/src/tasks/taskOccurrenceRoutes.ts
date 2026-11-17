import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";
import { occurrenceDatesInRange } from "./nextDueDate.js";
import { isCalendarDate } from "./taskRecurrenceOwner.js";
import {
  getTaskRecurrenceBySeriesId,
  hasSeriesOccurrence,
  publicTaskRecurrenceTemplate,
  type TaskRecurrenceTemplate,
} from "./taskRecurrenceStore.js";
import type { RouteParams, RouteBody, RouteUser } from "../customRoute.js";

/** Every other key is refused by name. */
const OCCURRENCE_FIELDS: ReadonlySet<string> = new Set(["status", "completedOn", "date", "timeFrom", "timeTo"]);

/** `missed` is written only by the Tasks module and the nightly job. */
const OCCURRENCE_STATUSES: readonly unknown[] = ["notDone", "done", "wontDo"];

/** The `owner: 'system'` properties a materialized occurrence is created with. */
const SERIES_PROPERTY_KEYS = ["seriesId", "occurrenceDate"] as const;

/** Lower-cased: occurrences store `seriesId` as PostgreSQL prints it, and the queries compare it as text. */
function seriesIdOf(ctx: RouteParams & RouteBody & RouteUser): string {
  const result = z.uuid().safeParse(ctx.params.seriesId);
  if (!result.success) throw new ValidationError("Series id must be a UUID", { field: "seriesId" });
  return result.data.toLowerCase();
}

function occurrenceDateOf(ctx: RouteParams & RouteBody & RouteUser): string {
  const date = ctx.params.date;
  if (!isCalendarDate(date)) {
    throw new ValidationError("The occurrence date must be a calendar date YYYY-MM-DD", { field: "occurrenceDate" });
  }
  return date;
}

function parsePatch(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("The body must be an object", { field: "body" });
  }
  const fields = z.record(z.string(), z.unknown()).parse(body);
  const unknownKey = Object.keys(fields).find((key) => !OCCURRENCE_FIELDS.has(key));
  if (unknownKey !== undefined) {
    throw new ValidationError(`Field '${unknownKey}' cannot be written on one occurrence`, { field: unknownKey });
  }
  if (Object.hasOwn(fields, "status") && !OCCURRENCE_STATUSES.includes(fields.status)) {
    throw new ValidationError("Property 'status' must be notDone, done or wontDo", { field: "status" });
  }
  return fields;
}

/**
 * One statement finds and locks the row, so PostgreSQL re-checks it after the lock: a row trashed or taken out
 * of the series meanwhile is not returned.
 */
async function lockOccurrence(
  client: PoolClient,
  databaseId: string,
  seriesId: string,
  occurrenceDate: string,
): Promise<ItemRow | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
     WHERE database_id = $1 AND deleted_at IS NULL
       AND properties->>'seriesId' = $2 AND properties->>'occurrenceDate' = $3
     ORDER BY id LIMIT 1 FOR NO KEY UPDATE`,
    [databaseId, seriesId, occurrenceDate],
  );
  return rows[0] ? itemsStore.getItemById(client, databaseId, rows[0].id) : null;
}

function templateProperties(template: TaskRecurrenceTemplate): Record<string, unknown> {
  const { name, ...rest } = publicTaskRecurrenceTemplate(template);
  return { ...(name === null ? {} : { name }), ...rest };
}

/**
 * `POST /api/tasks/series/:seriesId/occurrences/:date`: stores one occurrence as an item, or writes the item
 * already standing for it. Never writes the template or another occurrence.
 *
 * Locks the existing item, then `task_recurrence` `FOR UPDATE` (items before `task_recurrence`). Unknown,
 * turned-off and foreign series are not found alike; a date the rule does not give is 400 on `occurrenceDate`.
 *
 * A missing item is created as the Tasks module from the template with `notDone`. The body is then applied as
 * the caller's Tasks write, so `done`/`wontDo` on the current occurrence advances the series via the update hook.
 * Body schedule fields change this item only; `occurrenceDate` stays.
 *
 * 201 when created here, 200 when already stored, 409 when another request stored it concurrently.
 */
export function createTaskOccurrenceMaterializeRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody & RouteUser): Promise<{ status: number; item: ItemRow }> => {
    const seriesId = seriesIdOf(ctx);
    const occurrenceDate = occurrenceDateOf(ctx);
    const propertiesPatch = parsePatch(ctx.body);
    const userId = ctx.identity.user.id;
    return withTransaction(pool, async (client) => {
      const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
      if (!tasks) throw new NotFoundError(`Series ${seriesId} not found`);
      const stored = await lockOccurrence(client, tasks.id, seriesId, occurrenceDate);
      const series = await getTaskRecurrenceBySeriesId(client, seriesId, true);
      if (!series || !series.active) throw new NotFoundError(`Series ${seriesId} not found`);
      if (series.anchorDate === null || series.template === null) {
        throw new Error(`Series ${seriesId} has no anchor date or template`);
      }
      if (occurrenceDatesInRange(series.rule, series.anchorDate, occurrenceDate, occurrenceDate).length === 0) {
        throw new ValidationError("The series has no occurrence on that date", { field: "occurrenceDate" });
      }

      let occurrence = stored;
      if (!occurrence) {
        // The advance, the nightly close and this route all store occurrences under the series row lock, so none can
        // store this one in between. A series edit re-reads open occurrences under the same lock, so one that waited is
        // refused with 409 instead of leaving this item out.
        if (await hasSeriesOccurrence(client, tasks.id, seriesId, occurrenceDate)) {
          throw new ConflictError("The occurrence was stored while this request waited", { seriesId, occurrenceDate });
        }
        occurrence = await createItemWithClient(
          client,
          {
            databaseId: tasks.id,
            properties: {
              ...templateProperties(series.template),
              status: "notDone",
              date: occurrenceDate,
              seriesId,
              occurrenceDate,
            },
          },
          { allowedSystemKeys: SERIES_PROPERTY_KEYS, systemOwnerProcess: TASKS_MODULE_ID, actingUserId: userId },
        );
      }
      const status = stored === null ? 201 : 200;
      if (Object.keys(propertiesPatch).length === 0) return { status, item: occurrence };
      const item = await updateItemWithClient(
        client,
        { databaseId: tasks.id, itemId: occurrence.id, propertiesPatch },
        { writer: { writerKind: "user" }, actingUserId: userId, humanWriterUserId: userId },
      );
      return { status, item };
    });
  };
}
