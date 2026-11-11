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

interface Context {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string } };
}

/** The fields of one occurrence the body may write; every other key is refused by name. */
const OCCURRENCE_FIELDS: ReadonlySet<string> = new Set(["status", "completedOn", "date", "timeFrom", "timeTo"]);

/** The statuses a caller may give one occurrence; `missed` is written by the Tasks module and the nightly job. */
const OCCURRENCE_STATUSES: readonly unknown[] = ["notDone", "done", "wontDo"];

/** The `owner: 'system'` Tasks properties a materialized occurrence is created with (issue #1605). */
const SERIES_PROPERTY_KEYS = ["seriesId", "occurrenceDate"] as const;

/**
 * The series id of the path, in lower case. PostgreSQL prints `task_recurrence.series_id` in lower case, and that text
 * is what the occurrences of the series hold in `seriesId`. A path may spell the same UUID with upper-case digits; the
 * queries below compare `properties->>'seriesId'` as text, and a new occurrence stores the value returned here.
 */
function seriesIdOf(ctx: Context): string {
  const result = z.uuid().safeParse(ctx.params.seriesId);
  if (!result.success) throw new ValidationError("Series id must be a UUID", { field: "seriesId" });
  return result.data.toLowerCase();
}

function occurrenceDateOf(ctx: Context): string {
  const date = ctx.params.date;
  if (!isCalendarDate(date)) {
    throw new ValidationError("The occurrence date must be a calendar date YYYY-MM-DD", { field: "occurrenceDate" });
  }
  return date;
}

/**
 * The patch one occurrence takes: an object with `status`, `completedOn`, `date`, `timeFrom` and `timeTo`, each
 * optional. A `status` must be `notDone`, `done` or `wontDo`. The other four values are checked by the Tasks write
 * the patch is applied through.
 */
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
 * The live Tasks item that stands for `occurrenceDate` of series `seriesId`, with its row locked, or `null` when there
 * is none. One statement finds and locks the row, so PostgreSQL checks the row again once it has the lock: a row that
 * another transaction trashed or took out of the series while this one waited is not returned.
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
     ORDER BY id LIMIT 1 FOR UPDATE`,
    [databaseId, seriesId, occurrenceDate],
  );
  return rows[0] ? itemsStore.getItemById(client, databaseId, rows[0].id) : null;
}

/** A new occurrence's properties taken from the series template; a null `name` is left out, as the advance does. */
function templateProperties(template: TaskRecurrenceTemplate): Record<string, unknown> {
  const { name, ...rest } = publicTaskRecurrenceTemplate(template);
  return { ...(name === null ? {} : { name }), ...rest };
}

/**
 * `POST /api/tasks/series/:seriesId/occurrences/:date` (issue #1720): turns one occurrence of a recurring series into
 * a stored item, or writes the item that already stands for it. It writes neither the series template nor another
 * stored occurrence. `:date` is the occurrence's `occurrenceDate`.
 *
 * In one transaction it locks the live item with that `seriesId` and `occurrenceDate`, when there is one, and then the
 * `task_recurrence` row `FOR UPDATE` (items before `task_recurrence`,
 * docs/adr/2026-10-25-task-and-event-recurrence-model.md). An unknown, a turned-off and another tenant's series are
 * not found alike. A date the locked rule does not give on or after the series' anchor date is refused with 400 on
 * `occurrenceDate`, whether or not an item is stored for it.
 *
 * Without an item it creates one as the Tasks module: the template's `name`, `timeFrom`, `timeTo`, `notifications`,
 * `flagged` and `description`, `status` `notDone`, and `date`, `occurrenceDate` and `seriesId`. It then applies the
 * body to the item as the caller's own Tasks write, so `done` or `wontDo` on the series' current occurrence advances
 * the series through the Tasks update hook, and on any other occurrence creates nothing. A body `date`, `timeFrom` or
 * `timeTo` is written to this item alone; its `occurrenceDate` stays. An empty body writes nothing more.
 *
 * Responds with the item: 201 when this request created it, 200 when it was stored before. When another request
 * stored the occurrence after this one looked for it, this one is refused with 409 and creates nothing.
 */
export function createTaskOccurrenceMaterializeRouteHandler(pool: Pool) {
  return async (ctx: Context): Promise<{ status: number; item: ItemRow }> => {
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
        // Read while holding the series row lock, which the advance, the nightly close and this route all hold when
        // they store an occurrence of the series: none of them can store this one between the read and the create.
        // A series edit reads the series' open occurrences again under the same lock (taskSeriesRoutes.ts), so one
        // that waited for the row while this item was stored is refused with 409 and does not leave the item out.
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
