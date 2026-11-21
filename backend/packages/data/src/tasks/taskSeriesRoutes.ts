import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { normalizeWallClockTime } from "../timezone.js";
import type { ItemRow } from "../types.js";
import {
  getTaskRecurrenceBySeriesId,
  updateTaskRecurrenceTemplate,
  type TaskRecurrenceTemplate,
} from "./taskRecurrenceStore.js";
import type { CustomRouteResult, RouteParams, RouteBody, RouteUser } from "../customRoute.js";

/** The template fields a series edit may change; every other key is refused by name. */
const TEMPLATE_FIELDS = ["name", "timeFrom", "timeTo", "notifications", "flagged", "description"] as const;
type TemplateField = (typeof TEMPLATE_FIELDS)[number];
const TEMPLATE_FIELD_SET: ReadonlySet<string> = new Set(TEMPLATE_FIELDS);

function isTemplateField(key: string): key is TemplateField {
  return TEMPLATE_FIELD_SET.has(key);
}

/** Lower-cased: occurrences store `seriesId` as PostgreSQL prints it, and the query compares it as text. */
function seriesIdOf(ctx: RouteParams & RouteBody & RouteUser): string {
  const result = z.uuid().safeParse(ctx.params.seriesId);
  if (!result.success) throw new ValidationError("Series id must be a UUID", { field: "seriesId" });
  return result.data.toLowerCase();
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(`Property '${field}' must be true or false`, { field });
  return value;
}

/**
 * Checked as the Tasks write checks the same properties (non-blank `name`, `HH:MM` times, booleans, text or
 * `null` description). Single-occurrence fields and unknown keys are refused by name.
 */
function parsePatch(body: unknown): Partial<TaskRecurrenceTemplate> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("The body must be an object", { field: "body" });
  }
  const fields = z.record(z.string(), z.unknown()).parse(body);
  const patch: Partial<TaskRecurrenceTemplate> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!isTemplateField(key))
      throw new ValidationError(`Field '${key}' is not part of the series template`, { field: key });
    switch (key) {
      case "name":
        if (typeof value !== "string" || value.trim() === "") {
          throw new ValidationError("Property 'name' must be a non-empty title", { field: "name" });
        }
        patch.name = value;
        break;
      case "timeFrom":
        patch.timeFrom = normalizeWallClockTime(value, { field: "timeFrom" });
        break;
      case "timeTo":
        patch.timeTo = normalizeWallClockTime(value, { field: "timeTo", allow2400: true });
        break;
      case "notifications":
      case "flagged":
        patch[key] = boolean(value, key);
        break;
      case "description":
        if (value !== null && typeof value !== "string") {
          throw new ValidationError("Property 'description' must be text or null", { field: "description" });
        }
        patch.description = value;
        break;
    }
  }
  return patch;
}

/** An end needs a start and must be later than it, as in the Tasks write. */
function assertTemplateTimes(template: TaskRecurrenceTemplate): void {
  if (template.timeTo !== null && template.timeFrom === null) {
    throw new ValidationError("Property 'timeTo' requires a 'timeFrom'", { field: "timeTo" });
  }
  if (template.timeFrom !== null && template.timeTo !== null && template.timeTo <= template.timeFrom) {
    throw new ValidationError("Property 'timeTo' must be later than 'timeFrom'", { field: "timeTo" });
  }
}

/**
 * Open occurrences besides the current one: `notDone`, not trashed, dated on or after the current one, in id
 * order. `lock` locks them `FOR NO KEY UPDATE`; omit it once the series row is held (items before `task_recurrence`).
 */
async function openOccurrenceIds(
  client: PoolClient,
  databaseId: string,
  seriesId: string,
  current: ItemRow,
  lock: boolean,
): Promise<string[]> {
  const date = current.properties.date;
  if (typeof date !== "string") return [];
  // The suffix is one of two literals chosen here, never input.
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
     WHERE database_id = $1 AND deleted_at IS NULL AND id <> $2
       AND properties->>'seriesId' = $3 AND properties->>'status' = 'notDone' AND properties->>'date' >= $4
     ORDER BY id${lock ? " FOR NO KEY UPDATE" : ""}`,
    [databaseId, current.id, seriesId, date],
  );
  return rows.map((row) => row.id);
}

/**
 * `PATCH /api/tasks/series/:seriesId`: edits a series apart from its single occurrences. Locks the current
 * occurrence, then the open occurrences on or after it, then the series row (items before `task_recurrence`).
 * Merges the patch into the template and writes it through the Tasks write path to the current occurrence (if
 * open) and those occurrences; an occurrence's own `date` is never written.
 *
 * Unknown, inactive and foreign series are not found alike. 409 when the series advanced while waiting, or when
 * the re-read under the series lock finds an open occurrence the edit did not lock. Responds with `seriesId`,
 * `template`, and the current occurrence's `recurrence` and id.
 */
export function createTaskSeriesPatchRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody & RouteUser): Promise<CustomRouteResult> => {
    const seriesId = seriesIdOf(ctx);
    const patch = parsePatch(ctx.body);
    return withTransaction(pool, async (client) => {
      const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
      const found = tasks ? await getTaskRecurrenceBySeriesId(client, seriesId) : null;
      if (!tasks || !found || !found.active) throw new NotFoundError(`Series ${seriesId} not found`);
      const current = await itemsStore.lockItemById(client, tasks.id, found.itemId);
      if (!current || current.deletedAt) throw new ConflictError("The series has no current occurrence", { seriesId });
      const others = await openOccurrenceIds(client, tasks.id, seriesId, current, true);
      const series = await getTaskRecurrenceBySeriesId(client, seriesId, true);
      if (!series || !series.active || series.itemId !== current.id || series.template === null) {
        throw new ConflictError("The series changed while it was being edited", { seriesId });
      }
      // Re-read under the series row lock: the occurrence route creates open occurrences under that lock without moving
      // the row, so one committed while this edit waited was not locked above. The advance and nightly close use the
      // same lock, so nothing is created between this read and the commit.
      const open = await openOccurrenceIds(client, tasks.id, seriesId, current, false);
      if (open.some((id) => !others.includes(id))) {
        throw new ConflictError("The series changed while it was being edited", { seriesId });
      }
      const template = { ...series.template, ...patch };
      assertTemplateTimes(template);
      if (Object.keys(patch).length > 0) await updateTaskRecurrenceTemplate(client, seriesId, template);

      const userId = ctx.identity.user.id;
      // An empty patch changes nothing, so it writes no occurrence either.
      const changes = Object.keys(patch).length > 0;
      const targets = changes ? [...(current.properties.status === "notDone" ? [current.id] : []), ...others] : [];
      for (const itemId of targets) {
        await updateItemWithClient(
          client,
          { databaseId: tasks.id, itemId, propertiesPatch: { ...patch } },
          { writer: { writerKind: "user" }, actingUserId: userId, humanWriterUserId: userId },
        );
      }
      const after = await itemsStore.getItemById(client, tasks.id, current.id);
      return {
        status: 200,
        body: {
          seriesId,
          template,
          recurrence: after?.properties.recurrence ?? null,
          currentInstanceId: current.id,
        },
      };
    });
  };
}
