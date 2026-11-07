import { DateTime } from "luxon";
import type { PoolClient } from "pg";
import { z } from "zod";
import { assertKnownValue } from "../dbRowValidation.js";
import { ValidationError } from "../errors.js";
import { TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { ItemRow } from "../types.js";
import { occurrenceDatesInRange } from "./nextDueDate.js";
import { parseTaskRecurrenceRule, TASK_RECURRENCE_MODES } from "./taskRecurrenceRule.js";
import { parseTaskRecurrenceTemplate } from "./taskRecurrenceStore.js";

/** Longest range, in days with both ends counted, one projection may cover (issue #1672). */
const MAX_RANGE_DAYS = 400;

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ProjectTaskOccurrencesInput {
  /** First day of the range, `YYYY-MM-DD`. */
  from: string;
  /** Last day of the range, `YYYY-MM-DD`, inclusive. */
  to: string;
  /** The caller's today, `YYYY-MM-DD`: virtual occurrences before it are `missed`, the others `notDone`. */
  today: string;
}

/**
 * One occurrence of a recurring task series within the range: the stored item when the occurrence is materialized,
 * otherwise a virtual occurrence addressed as `<seriesId>@<occurrenceDate>`
 * (docs/adr/2026-10-25-task-and-event-recurrence-model.md).
 */
export type ProjectedTaskOccurrence =
  | { virtual: false; seriesId: string; occurrenceDate: string; item: ItemRow }
  | { virtual: true; id: string; seriesId: string; occurrenceDate: string; properties: Record<string, unknown> };

const seriesRowSchema = z.object({
  series_id: z.string(),
  mode: z.string(),
  rule: z.unknown(),
  anchor_date: z.string(),
  template: z.unknown(),
  active: z.boolean(),
  last_occurrence: z.string().nullable(),
});

const itemRowSchema = z.object({
  id: z.string(),
  database_id: z.string(),
  properties: z.record(z.string(), z.unknown()),
  computed: z.record(z.string(), z.unknown()),
  created_at: z.date(),
  updated_at: z.date(),
  series_id: z.string(),
  occurrence_date: z.string(),
});

function requireCalendarDate(value: string, field: keyof ProjectTaskOccurrencesInput): DateTime {
  const day = CALENDAR_DATE.test(value) ? DateTime.fromISO(value, { zone: "utc" }) : null;
  if (!day?.isValid) throw new ValidationError(`'${field}' must be a calendar date YYYY-MM-DD`, { field });
  return day;
}

/**
 * Projects the occurrences of every recurring task series over `[from, to]` (issue #1672). For each date its rule
 * gives in the range, not before the series' `anchor_date`, it returns the non-deleted item with that `seriesId` and
 * `occurrenceDate` when one exists, else a virtual occurrence whose properties are the series template plus `date`
 * and `status` (`missed` before `today`, `notDone` from `today`). A materialized occurrence in the range is returned
 * even when its date is not a rule date. A series that was turned off (`active` false) produces no virtual
 * occurrence after its last materialized occurrence, and none at all when it has none.
 *
 * Reads with two queries whatever the range: one for the series rows (with the last materialized occurrence of
 * each inactive series), one for the materialized occurrences in the range. A range over 400 days, an inverted
 * range or a value that is not a calendar date is rejected with a `ValidationError`. Writes nothing.
 */
export async function projectTaskOccurrences(
  client: PoolClient,
  input: ProjectTaskOccurrencesInput,
): Promise<ProjectedTaskOccurrence[]> {
  const from = requireCalendarDate(input.from, "from");
  const to = requireCalendarDate(input.to, "to");
  requireCalendarDate(input.today, "today");
  if (to < from) throw new ValidationError("'to' must not be before 'from'", { field: "to" });
  if (to.diff(from, "days").days + 1 > MAX_RANGE_DAYS) {
    throw new ValidationError(`A projection covers at most ${MAX_RANGE_DAYS} days`, { field: "to" });
  }

  const seriesResult = await client.query<z.input<typeof seriesRowSchema>>(
    `SELECT r.series_id::text AS series_id, r.mode, r.rule, r.anchor_date::text AS anchor_date, r.template, r.active,
       CASE WHEN r.active THEN NULL ELSE (
         SELECT max(i.properties->>'occurrenceDate') FROM items i
         WHERE i.database_id = (SELECT id FROM databases WHERE owner_module_id = $1)
           AND i.deleted_at IS NULL AND i.properties->>'seriesId' = r.series_id::text
       ) END AS last_occurrence
     FROM task_recurrence r
     WHERE r.series_id IS NOT NULL AND r.anchor_date IS NOT NULL
     ORDER BY r.series_id`,
    [TASKS_MODULE_ID],
  );
  const series = seriesResult.rows.map((raw) => {
    const row = seriesRowSchema.parse(raw);
    const mode = assertKnownValue(TASK_RECURRENCE_MODES, row.mode, "task recurrence mode");
    return {
      seriesId: row.series_id,
      rule: parseTaskRecurrenceRule(mode, row.rule),
      anchorDate: row.anchor_date,
      template: parseTaskRecurrenceTemplate(row.template),
      lastVirtualDate: row.active ? input.to : row.last_occurrence,
    };
  });
  if (series.length === 0) return [];

  const itemsResult = await client.query<z.input<typeof itemRowSchema>>(
    `SELECT id, database_id, properties, computed, created_at, updated_at,
       properties->>'seriesId' AS series_id, properties->>'occurrenceDate' AS occurrence_date
     FROM items
     WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = $1) AND deleted_at IS NULL
       AND properties->>'seriesId' = ANY($2::text[])
       AND properties->>'occurrenceDate' BETWEEN $3 AND $4
     ORDER BY properties->>'occurrenceDate', id`,
    [TASKS_MODULE_ID, series.map((entry) => entry.seriesId), input.from, input.to],
  );
  const occurrences: ProjectedTaskOccurrence[] = [];
  const materialized = new Set<string>();
  for (const raw of itemsResult.rows) {
    const row = itemRowSchema.parse(raw);
    materialized.add(`${row.series_id}@${row.occurrence_date}`);
    occurrences.push({
      virtual: false,
      seriesId: row.series_id,
      occurrenceDate: row.occurrence_date,
      item: {
        id: row.id,
        databaseId: row.database_id,
        properties: row.properties,
        computed: row.computed,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        // The query reads non-deleted items only.
        deletedAt: null,
      },
    });
  }

  for (const entry of series) {
    if (entry.lastVirtualDate === null) continue;
    const end = entry.lastVirtualDate < input.to ? entry.lastVirtualDate : input.to;
    for (const date of occurrenceDatesInRange(entry.rule, entry.anchorDate, input.from, end)) {
      const id = `${entry.seriesId}@${date}`;
      if (materialized.has(id)) continue;
      occurrences.push({
        virtual: true,
        id,
        seriesId: entry.seriesId,
        occurrenceDate: date,
        properties: { ...entry.template, date, status: date < input.today ? "missed" : "notDone" },
      });
    }
  }
  return occurrences.sort(
    (a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate) || a.seriesId.localeCompare(b.seriesId),
  );
}
