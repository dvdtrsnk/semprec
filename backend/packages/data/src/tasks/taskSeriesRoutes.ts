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
  publicTaskRecurrenceTemplate,
  updateTaskRecurrenceTemplate,
  type TaskRecurrenceTemplate,
} from "./taskRecurrenceStore.js";

interface Context {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string } };
}

/**
 * The template fields a series edit may change; every other key is refused by name. `persistent` was one until issue
 * #2009 removed the Tasks property; it is refused now like any other key, and responses omit it.
 */
const TEMPLATE_FIELDS = ["name", "timeFrom", "timeTo", "notifications", "flagged", "description"] as const;
type TemplateField = (typeof TEMPLATE_FIELDS)[number];
const TEMPLATE_FIELD_SET: ReadonlySet<string> = new Set(TEMPLATE_FIELDS);

function isTemplateField(key: string): key is TemplateField {
  return TEMPLATE_FIELD_SET.has(key);
}

function seriesIdOf(ctx: Context): string {
  const result = z.uuid().safeParse(ctx.params.seriesId);
  if (!result.success) throw new ValidationError("Series id must be a UUID", { field: "seriesId" });
  return result.data;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(`Property '${field}' must be true or false`, { field });
  return value;
}

/**
 * The patch a series edit stores, checked as the Tasks write checks the same properties: a non-blank `name`, `HH:MM`
 * times (`H:MM` is padded, only `timeTo` may be `24:00`, `null` clears), booleans for the checkboxes and a text or
 * `null` description. A field of a single occurrence (`date`, `status`, ...) or any other key is refused by name.
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

/** The template's own time rule, as the Tasks write applies it: an end needs a start and must be later than it. */
function assertTemplateTimes(template: TaskRecurrenceTemplate): void {
  if (template.timeTo !== null && template.timeFrom === null) {
    throw new ValidationError("Property 'timeTo' requires a 'timeFrom'", { field: "timeTo" });
  }
  if (template.timeFrom !== null && template.timeTo !== null && template.timeTo <= template.timeFrom) {
    throw new ValidationError("Property 'timeTo' must be later than 'timeFrom'", { field: "timeTo" });
  }
}

/**
 * The open occurrences of a series the edit reaches besides its current one: `notDone`, not trashed and dated on or
 * after the current occurrence's `date`, locked in id order. Done, wontDo and missed occurrences and earlier ones are
 * never selected.
 */
async function lockOpenOccurrences(
  client: PoolClient,
  databaseId: string,
  seriesId: string,
  current: ItemRow,
): Promise<string[]> {
  const date = current.properties.date;
  if (typeof date !== "string") return [];
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
     WHERE database_id = $1 AND deleted_at IS NULL AND id <> $2
       AND properties->>'seriesId' = $3 AND properties->>'status' = 'notDone' AND properties->>'date' >= $4
     ORDER BY id FOR UPDATE`,
    [databaseId, current.id, seriesId, date],
  );
  return rows.map((row) => row.id);
}

/**
 * `PATCH /api/tasks/series/:seriesId` (issue #1667): edits a recurring series apart from its single occurrences. In one
 * transaction it locks the series' current occurrence, then the open materialized occurrences dated on or after it, all
 * of them before the `task_recurrence` row (items before `task_recurrence`,
 * docs/adr/2026-10-25-task-and-event-recurrence-model.md), then the series row `FOR UPDATE`. It merges the patch into
 * the template and writes the same patch to the current occurrence, when it is open, and to those occurrences through
 * the Tasks write path, which validates each of them again. An occurrence's own `date` is never written, so one moved
 * on its own keeps it. An unknown, inactive or another tenant's series is not found alike; a series that advanced to
 * another occurrence while the edit waited is a 409. Responds with the series: `seriesId`, `template`, the current
 * occurrence's `recurrence` and its id.
 */
export function createTaskSeriesPatchRouteHandler(pool: Pool) {
  return async (ctx: Context): Promise<{ status: number; body: unknown }> => {
    const seriesId = seriesIdOf(ctx);
    const patch = parsePatch(ctx.body);
    return withTransaction(pool, async (client) => {
      const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
      const found = tasks ? await getTaskRecurrenceBySeriesId(client, seriesId) : null;
      if (!tasks || !found || !found.active) throw new NotFoundError(`Series ${seriesId} not found`);
      const current = await itemsStore.lockItemById(client, tasks.id, found.itemId);
      if (!current || current.deletedAt) throw new ConflictError("The series has no current occurrence", { seriesId });
      const others = await lockOpenOccurrences(client, tasks.id, seriesId, current);
      const series = await getTaskRecurrenceBySeriesId(client, seriesId, true);
      if (!series || !series.active || series.itemId !== current.id || series.template === null) {
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
          template: publicTaskRecurrenceTemplate(template),
          recurrence: after?.properties.recurrence ?? null,
          currentInstanceId: current.id,
        },
      };
    });
  };
}
