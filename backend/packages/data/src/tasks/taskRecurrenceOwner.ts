import { isDeepStrictEqual } from "node:util";
import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { ItemRow } from "../types.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { requireApprovalForWrite } from "../chokePoint/writeApproval.js";
import { ValidationError } from "../errors.js";
import { parseTaskRecurrenceRule, TASK_RECURRENCE_MODES, type TaskRecurrenceMode, type TaskRecurrenceRule, type Weekday } from "./taskRecurrenceRule.js";
import { createTaskRecurrence, deactivateTaskRecurrenceSeries, getTaskRecurrence, getTaskRecurrenceBySeriesId, replaceTaskRecurrenceRule, restartTaskRecurrence, type TaskRecurrenceTemplate } from "./taskRecurrenceStore.js";

const PRESETS = ["daily", "weekdays", "weekly", "monthly", "yearly"] as const;
type Preset = (typeof PRESETS)[number];
const REQUEST_KEYS = new Set(["preset", "mode", "rule", "date"]);
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Luxon weekday numbers 1 (Monday) to 7 (Sunday), as rule weekday names. */
const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export interface RecurrenceRequest {
  preset: Preset | null;
  mode: TaskRecurrenceMode;
  /** Unparsed until the effective date is known: a preset's rule depends on it. */
  rule: unknown;
  date: string | undefined;
}

export function isCalendarDate(value: unknown): value is string {
  return typeof value === "string" && CALENDAR_DATE.test(value) && DateTime.fromISO(value, { zone: "utc" }).isValid;
}

/** `{preset}` or `{mode, rule}`, each with an optional `date`; any other key is refused by name. */
export function parseRequest(body: unknown): RecurrenceRequest {
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
export function resolveRule(request: RecurrenceRequest, date: string): TaskRecurrenceRule {
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
export function templateOf(properties: Record<string, unknown>): TaskRecurrenceTemplate {
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


export function validateRecurrenceCommand(value: unknown): void {
  if (value !== null) {
    const request = parseRequest(value);
    if (request.date !== undefined) throw new ValidationError("Date belongs in the item patch", { field: "recurrence" });
  }
}

export async function applyRecurrenceCommand(client: PoolClient, task: ItemRow, patch: Record<string, unknown>, value: unknown, writer: WriterIdentity, preserveRouteWrite = false): Promise<Record<string, unknown>> {
  const seriesId = typeof task.properties.seriesId === "string" ? task.properties.seriesId : null;
  const series = seriesId ? await getTaskRecurrenceBySeriesId(client, seriesId, true) : await getTaskRecurrence(client, task.id, true);
  if (seriesId && (!series || series.itemId !== task.id)) throw new ValidationError("Only the current occurrence of a series can change its recurrence", { field: "id" });
  if (value === null) {
    if (!seriesId || !series) return {};
    if (series.active) {
      const reason = { kind: "changesSeries", seriesId, from: series.rule, to: null };
      requireApprovalForWrite(client, writer, [reason]);
    }
    await deactivateTaskRecurrenceSeries(client, seriesId);
    return { seriesId: null, occurrenceDate: null, recurrence: null };
  }
  const request = parseRequest(value);
  const properties = { ...task.properties, ...patch };
  const date = request.date ?? (isCalendarDate(properties.date) ? properties.date : null);
  if (!date) throw new ValidationError("A recurring task needs a date", { field: "date" });
  const rule = resolveRule(request, date);
  if (seriesId && series) {
    if (!preserveRouteWrite && series.active && series.mode === request.mode && isDeepStrictEqual(series.rule, rule) && request.date === undefined) return {};
    const reason = { kind: "changesSeries", seriesId, from: series.rule, to: rule };
    requireApprovalForWrite(client, writer, [reason]);
    const updated = await replaceTaskRecurrenceRule(client, seriesId, { mode: request.mode, rule, anchorDate: request.date });
    const occurrenceDate = request.date === undefined && isCalendarDate(task.properties.occurrenceDate) ? task.properties.occurrenceDate : date;
    return { ...(request.date === undefined ? {} : { date }), seriesId: updated.seriesId, occurrenceDate, recurrence: { preset: request.preset, mode: request.mode, rule } };
  }
  const input = { itemId: task.id, mode: request.mode, rule, anchorDate: date, template: templateOf(properties) };
  const created = series === null ? await createTaskRecurrence(client, input) : !series.active ? await restartTaskRecurrence(client, input) : null;
  if (!created) throw new Error(`Task ${task.id} has an active recurrence row but no series property`);
  return { ...(request.date === undefined ? {} : { date }), seriesId: created.seriesId, occurrenceDate: date, recurrence: { preset: request.preset, mode: request.mode, rule } };
}

export async function projectRecurrenceApproval(client: PoolClient, task: ItemRow, patch: Record<string, unknown>) {
  if (!Object.hasOwn(patch, "recurrence")) return null;
  const seriesId = typeof task.properties.seriesId === "string" ? task.properties.seriesId : null;
  const series = seriesId ? await getTaskRecurrenceBySeriesId(client, seriesId, true) : null;
  if (!series || !series.active || series.itemId !== task.id) throw new ValidationError("Series changed before approval", { field: "recurrence" });
  const value = patch.recurrence;
  validateRecurrenceCommand(value);
  const date = isCalendarDate(patch.date) ? patch.date : isCalendarDate(task.properties.date) ? task.properties.date : null;
  if (!date) throw new ValidationError("A recurring task needs a date", { field: "date" });
  const request = value === null ? null : parseRequest(value);
  const to = request ? resolveRule(request, date) : null;
  if (request && series.mode === request.mode && isDeepStrictEqual(series.rule, to)) throw new ValidationError("Series changed before approval", { field: "recurrence" });
  return {
    snapshot: { seriesId: series.seriesId, active: series.active, mode: series.mode, rule: series.rule, date: task.properties.date ?? null },
    description: { key: "approval.changesSeries", params: { taskName: typeof task.properties.name === "string" ? task.properties.name : null, fromRule: JSON.stringify(series.rule), toRule: to === null ? "" : JSON.stringify(to) } },
  };
}
