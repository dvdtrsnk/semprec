import { DateTime } from "luxon";
import type { Pool } from "pg";
import { z } from "zod";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { requireAffectedRows, requireSingleRow, withTransaction } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  parseTaskRecurrenceRule,
  TASK_RECURRENCE_MODES,
  type TaskRecurrenceMode,
  type TaskRecurrenceRule,
  type Weekday,
} from "./taskRecurrenceRule.js";
import type { TaskRecurrenceTemplate } from "./taskRecurrenceStore.js";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Luxon weekday numbers 1 (Monday) to 7 (Sunday), as rule weekday names. */
const LUXON_WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WORKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri"];

const propertiesSchema = z.record(z.string(), z.unknown());

/**
 * The preset a stored rule corresponds to, by the preset definitions of the recurrence route (#1665): `daily` is
 * fixed weekdays with all seven days, `weekdays` is Monday to Friday, `weekly` is the one weekday of the instance's
 * `date`, `monthly` is the one month date of the instance's `date`. Any other rule, a floating one included, has none.
 */
function presetOf(mode: TaskRecurrenceMode, rule: TaskRecurrenceRule, date: DateTime): string | null {
  if (mode !== "fixed" || !("kind" in rule)) return null;
  if (rule.kind === "weekdays") {
    const days = new Set(rule.days);
    if (days.size === LUXON_WEEKDAYS.length) return "daily";
    if (days.size === WORKDAYS.length && WORKDAYS.every((day) => days.has(day))) return "weekdays";
    if (days.size === 1 && days.has(LUXON_WEEKDAYS[date.weekday - 1]!)) return "weekly";
    return null;
  }
  if (rule.kind === "monthDates") {
    const dates = new Set(rule.dates);
    return dates.size === 1 && dates.has(date.day) ? "monthly" : null;
  }
  return null;
}

/** The series template taken from an instance's properties; a value of the wrong type is stored as its default. */
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

function calendarDate(value: unknown): DateTime | null {
  if (typeof value !== "string" || !CALENDAR_DATE.test(value)) return null;
  const date = DateTime.fromISO(value, { zone: "utc" });
  return date.isValid ? date : null;
}

/**
 * Per-tenant cutover of issue #1605: gives every active `task_recurrence` row without a series a new `series_id`,
 * its instance's `date` as `anchor_date` and the instance's template, and writes `seriesId`, `occurrenceDate`
 * (the instance's `date`) and `recurrence` (`{preset, mode, rule}`) onto the instance's properties. Written as SQL
 * against both tables, like the other data cutovers; the item backfill does not change `updated_at` and announces
 * nothing.
 *
 * Idempotent: a row that already has a series is never selected, so a second run changes nothing. Inactive rows and
 * done instances get no series (their history is not reconstructed). Every other candidate must get one: when an
 * active row without a series has no Tasks instance, an instance without a valid calendar `date`, or the tenant has
 * no Tasks database at all, the step throws before writing, so the tenant's transaction rolls back unchanged and the
 * tenant runner reports the failure. No anchor is invented and no row is deactivated or skipped.
 *
 * One transaction per tenant. Lock order of docs/adr/2026-10-25-task-and-event-recurrence-model.md: the instance
 * items first, then their `task_recurrence` rows, each in id order; both are re-checked under their locks.
 */
export async function runTaskRecurrenceSeriesCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    const candidates = await client.query<{ item_id: string }>(
      "SELECT item_id FROM task_recurrence WHERE active AND series_id IS NULL ORDER BY item_id",
    );
    const candidateIds = candidates.rows.map((row) => row.item_id);
    if (candidateIds.length === 0) return;
    const tasks = await getDatabaseByModuleId(client, TASKS_MODULE_ID);
    if (!tasks) {
      throw new Error(`Task recurrence series cutover: ${candidateIds.length} active rows but no Tasks database`);
    }

    const items = await client.query<{ id: string; properties: unknown }>(
      "SELECT id, properties FROM items WHERE database_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE",
      [tasks.id, candidateIds],
    );
    const propertiesById = new Map(items.rows.map((row) => [row.id, propertiesSchema.parse(row.properties)]));
    const rows = await client.query<{ item_id: string; mode: string; rule: unknown }>(
      `SELECT item_id, mode, rule FROM task_recurrence
       WHERE item_id = ANY($1::uuid[]) AND active AND series_id IS NULL ORDER BY item_id FOR UPDATE`,
      [candidateIds],
    );

    const eligible: Array<{
      itemId: string;
      mode: string;
      rule: unknown;
      properties: Record<string, unknown>;
      date: DateTime;
    }> = [];
    const withoutAnchor: string[] = [];
    for (const row of rows.rows) {
      const properties = propertiesById.get(row.item_id);
      if (properties?.status === "done") continue;
      const date = properties ? calendarDate(properties.date) : null;
      if (!properties || !date) withoutAnchor.push(row.item_id);
      else eligible.push({ itemId: row.item_id, mode: row.mode, rule: row.rule, properties, date });
    }
    if (withoutAnchor.length > 0) {
      throw new Error(
        `Task recurrence series cutover: active rows without a Tasks instance or a valid date: ${withoutAnchor.join(", ")}`,
      );
    }

    for (const row of eligible) {
      const mode = assertKnownValue(TASK_RECURRENCE_MODES, row.mode, "task recurrence mode");
      const rule = parseTaskRecurrenceRule(mode, row.rule);
      const occurrenceDate = row.date.toFormat("yyyy-MM-dd");
      const series = await client.query<{ series_id: string }>(
        `UPDATE task_recurrence SET series_id = gen_random_uuid(), anchor_date = $2::date, template = $3::jsonb
         WHERE item_id = $1 AND series_id IS NULL RETURNING series_id::text AS series_id`,
        [row.itemId, occurrenceDate, JSON.stringify(templateOf(row.properties))],
      );
      requireAffectedRows(series, "task_recurrence series");
      const seriesId = requireSingleRow(series.rows, "task_recurrence series").series_id;
      const recurrence = { preset: presetOf(mode, rule, row.date), mode, rule };
      const instance = await client.query(
        `UPDATE items SET properties = properties || jsonb_build_object('seriesId', $3::text, 'occurrenceDate', $4::text, 'recurrence', $5::jsonb)
         WHERE database_id = $1 AND id = $2`,
        [tasks.id, row.itemId, seriesId, occurrenceDate, JSON.stringify(recurrence)],
      );
      requireAffectedRows(instance, "recurring task series properties");
    }
  });
}
