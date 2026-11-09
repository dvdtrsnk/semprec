import { DateTime } from "luxon";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";
import {
  parseTaskRecurrenceRule,
  TASK_RECURRENCE_MODES,
  type TaskRecurrenceMode,
  type TaskRecurrenceRule,
  type Weekday,
} from "./taskRecurrenceRule.js";
import {
  createTaskRecurrence,
  deactivateTaskRecurrenceSeries,
  getTaskRecurrence,
  getTaskRecurrenceBySeriesId,
  replaceTaskRecurrenceRule,
  restartTaskRecurrence,
  type TaskRecurrence,
  type TaskRecurrenceTemplate,
} from "./taskRecurrenceStore.js";

interface Context {
  params: Record<string, string>;
  body: unknown;
  identity: { user: { id: string } };
}

/** The `owner: 'system'` Tasks properties these routes write as the Tasks module (issue #1605). */
const SERIES_PROPERTY_KEYS = ["seriesId", "occurrenceDate", "recurrence"] as const;
const PRESETS = ["daily", "weekdays", "weekly", "monthly", "yearly"] as const;
type Preset = (typeof PRESETS)[number];
const REQUEST_KEYS = new Set(["preset", "mode", "rule", "date"]);
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Luxon weekday numbers 1 (Monday) to 7 (Sunday), as rule weekday names. */
const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

interface RecurrenceRequest {
  preset: Preset | null;
  mode: TaskRecurrenceMode;
  /** Unparsed until the effective date is known: a preset's rule depends on it. */
  rule: unknown;
  date: string | undefined;
}

function isCalendarDate(value: unknown): value is string {
  return typeof value === "string" && CALENDAR_DATE.test(value) && DateTime.fromISO(value, { zone: "utc" }).isValid;
}

function taskId(ctx: Context): string {
  const result = z.uuid().safeParse(ctx.params.id);
  if (!result.success) throw new ValidationError("Task id must be a UUID", { field: "id" });
  return result.data;
}

/** `{preset}` or `{mode, rule}`, each with an optional `date`; any other key is refused by name. */
function parseRequest(body: unknown): RecurrenceRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("The body must be an object", { field: "body" });
  }
  const fields = z.record(z.string(), z.unknown()).parse(body);
  const unknownKey = Object.keys(fields).find((key) => !REQUEST_KEYS.has(key));
  if (unknownKey !== undefined) throw new ValidationError(`Unknown field '${unknownKey}'`, { field: unknownKey });
  const date = fields.date;
  if (date !== undefined && !isCalendarDate(date)) {
    throw new ValidationError("Property 'date' must be a calendar date YYYY-MM-DD", { field: "date" });
  }
  if (Object.hasOwn(fields, "preset")) {
    if (Object.hasOwn(fields, "mode") || Object.hasOwn(fields, "rule")) {
      throw new ValidationError("Send either a preset or a mode and rule", { field: "preset" });
    }
    const preset = z.enum(PRESETS).safeParse(fields.preset);
    if (!preset.success) throw new ValidationError("Unknown recurrence preset", { field: "preset" });
    return { preset: preset.data, mode: "fixed", rule: undefined, date };
  }
  const mode = z.enum(TASK_RECURRENCE_MODES).safeParse(fields.mode);
  if (!mode.success) throw new ValidationError("Recurrence mode must be fixed or floating", { field: "mode" });
  if (!Object.hasOwn(fields, "rule")) throw new ValidationError("A recurrence rule is required", { field: "rule" });
  return { preset: null, mode: mode.data, rule: fields.rule, date };
}

/**
 * The rule a request stands for on `date`: `daily` is fixed weekdays with all seven days (not floating), `weekdays`
 * Monday to Friday, `weekly` the weekday of `date`, `monthly` the day of the month of `date`; `{mode, rule}` is parsed
 * with the existing rule schema.
 */
function resolveRule(request: RecurrenceRequest, date: string): TaskRecurrenceRule {
  const day = DateTime.fromISO(date, { zone: "utc" });
  switch (request.preset) {
    case "daily":
      return { kind: "weekdays", days: [...WEEKDAYS] };
    case "weekdays":
      return { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] };
    case "weekly":
      return { kind: "weekdays", days: [WEEKDAYS[day.weekday - 1]!] };
    case "monthly":
      return { kind: "monthDates", dates: [day.day] };
    case "yearly":
      return { kind: "yearDates", month: day.month, day: day.day };
    case null:
      try {
        return parseTaskRecurrenceRule(request.mode, request.rule);
      } catch (error) {
        if (error instanceof z.ZodError) throw new ValidationError("Invalid recurrence rule", { field: "rule" });
        throw error;
      }
  }
}

/** A new series' template, taken from the task it starts from; a value of the wrong type is stored as its default. */
function templateOf(properties: Record<string, unknown>): TaskRecurrenceTemplate {
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    name: text(properties.name),
    timeFrom: text(properties.timeFrom),
    timeTo: text(properties.timeTo),
    notifications: properties.notifications === true,
    persistent: properties.persistent === true,
    flagged: properties.flagged === true,
    description: text(properties.description),
  };
}

/** The Tasks database and the task `id`, locked; another tenant's task and a trashed one are not found alike. */
async function lockTask(client: PoolClient, id: string): Promise<{ databaseId: string; task: ItemRow }> {
  const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
  const task = tasks ? await itemsStore.lockItemById(client, tasks.id, id) : null;
  if (!tasks || !task || task.deletedAt) throw new NotFoundError(`Task ${id} not found`);
  return { databaseId: tasks.id, task };
}

/**
 * The series row of a task that has a `seriesId`, locked after the task. Only the series' current occurrence may change
 * or end its recurrence; an older occurrence, or one whose series row is gone, is refused on `id`.
 */
async function lockCurrentSeries(client: PoolClient, task: ItemRow, seriesId: string): Promise<TaskRecurrence> {
  const series = await getTaskRecurrenceBySeriesId(client, seriesId, true);
  if (!series || series.itemId !== task.id) {
    throw new ValidationError("Only the current occurrence of a series can change its recurrence", { field: "id" });
  }
  return series;
}

async function writeSeriesProperties(
  client: PoolClient,
  ctx: Context,
  databaseId: string,
  taskId: string,
  propertiesPatch: Record<string, unknown>,
): Promise<ItemRow> {
  const userId = ctx.identity.user.id;
  await updateItemWithClient(
    client,
    { databaseId, itemId: taskId, propertiesPatch },
    {
      allowedSystemKeys: SERIES_PROPERTY_KEYS,
      systemOwnerProcess: TASKS_MODULE_ID,
      writer: { writerKind: "user" },
      actingUserId: userId,
      humanWriterUserId: userId,
    },
  );
  const updated = await itemsStore.getItemById(client, databaseId, taskId);
  if (!updated) throw new Error(`Task ${taskId} disappeared during its recurrence write`);
  return updated;
}

/**
 * `PUT /api/tasks/:id/recurrence` (issue #1665): sets or changes a task's recurrence from `{preset}` or `{mode, rule}`,
 * optionally with a new `date`. In one transaction it locks the task, then its `task_recurrence` row. A task without a
 * series gets a new one (a new row, or its own inactive row restarted with a new `seriesId`); the current occurrence of
 * a series gets the rule replaced. The task's `date` (when sent), `seriesId`, `occurrenceDate` and
 * `recurrence` (`{preset, mode, rule}`) are written through the Tasks write path in the same transaction; a sent
 * `date` also moves the series anchor. A task without a date is refused on `date`.
 */
export function createTaskRecurrenceSetRouteHandler(pool: Pool) {
  return async (ctx: Context): Promise<{ status: number; item: ItemRow }> => {
    const id = taskId(ctx);
    const request = parseRequest(ctx.body);
    return withTransaction(pool, async (client) => {
      const { databaseId, task } = await lockTask(client, id);
      const date = request.date ?? (isCalendarDate(task.properties.date) ? task.properties.date : null);
      if (date === null) throw new ValidationError("A recurring task needs a date", { field: "date" });
      const rule = resolveRule(request, date);
      const currentSeriesId = typeof task.properties.seriesId === "string" ? task.properties.seriesId : null;
      let series: TaskRecurrence;
      let occurrenceDate = date;
      if (currentSeriesId !== null) {
        await lockCurrentSeries(client, task, currentSeriesId);
        series = await replaceTaskRecurrenceRule(client, currentSeriesId, {
          mode: request.mode,
          rule,
          anchorDate: request.date,
        });
        if (request.date === undefined && isCalendarDate(task.properties.occurrenceDate)) {
          occurrenceDate = task.properties.occurrenceDate;
        }
      } else {
        const existing = await getTaskRecurrence(client, task.id, true);
        const input = {
          itemId: task.id,
          mode: request.mode,
          rule,
          anchorDate: date,
          template: templateOf(task.properties),
        };
        if (existing === null) series = await createTaskRecurrence(client, input);
        else if (!existing.active) series = await restartTaskRecurrence(client, input);
        else throw new Error(`Task ${task.id} has an active recurrence row but no series property`);
      }
      const item = await writeSeriesProperties(client, ctx, databaseId, task.id, {
        ...(request.date === undefined ? {} : { date: request.date }),
        seriesId: series.seriesId,
        occurrenceDate,
        recurrence: { preset: request.preset, mode: request.mode, rule },
      });
      return { status: 200, item };
    });
  };
}

/**
 * `DELETE /api/tasks/:id/recurrence` (issue #1665): turns a task's recurrence off. It locks the task, then its series
 * row, deactivates the series and clears `seriesId`, `occurrenceDate` and `recurrence` on the task, which keeps its
 * `date` as a non-recurring task. A task without a series is returned unchanged.
 */
export function createTaskRecurrenceClearRouteHandler(pool: Pool) {
  return async (ctx: Context): Promise<{ status: number; item: ItemRow }> => {
    const id = taskId(ctx);
    return withTransaction(pool, async (client) => {
      const { databaseId, task } = await lockTask(client, id);
      const seriesId = typeof task.properties.seriesId === "string" ? task.properties.seriesId : null;
      if (seriesId === null) return { status: 200, item: task };
      await lockCurrentSeries(client, task, seriesId);
      await deactivateTaskRecurrenceSeries(client, seriesId);
      const item = await writeSeriesProperties(client, ctx, databaseId, task.id, {
        seriesId: null,
        occurrenceDate: null,
        recurrence: null,
      });
      return { status: 200, item };
    });
  };
}
