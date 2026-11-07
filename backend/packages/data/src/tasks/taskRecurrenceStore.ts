import type { PoolClient } from "pg";
import { z } from "zod";
import { requireAffectedRows, requireSingleRow } from "../db/pool.js";
import type { Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import {
  parseTaskRecurrenceRule,
  TASK_RECURRENCE_MODES,
  type TaskRecurrenceMode,
  type TaskRecurrenceRule,
} from "./taskRecurrenceRule.js";

/**
 * The properties a series' occurrences are created from (issue #1605). The advance takes `name`, `timeFrom`,
 * `timeTo`, `notifications` and `persistent` from it and `flagged`/`description` from the completed occurrence
 * (#1673); the projection uses all seven for a virtual occurrence (#1672).
 */
const templateSchema = z
  .object({
    name: z.string().nullable(),
    timeFrom: z.string().nullable(),
    timeTo: z.string().nullable(),
    notifications: z.boolean(),
    persistent: z.boolean(),
    flagged: z.boolean(),
    description: z.string().nullable(),
  })
  .strict();

export type TaskRecurrenceTemplate = z.infer<typeof templateSchema>;

/**
 * Not `types.ts`'s `TaskRecurrenceRow` (which keeps `rule` as a loosely-typed jsonb bag,
 * matching how other Row types like `PropertyRow.config` stay untyped at that layer) — this
 * store's callers (advanceTaskRecurrenceWithClient.ts) need the already-validated, discriminated
 * `TaskRecurrenceRule`, not a round-trip cast back through `unknown`.
 *
 * `seriesId`, `anchorDate` and `template` are null on a row without a series: one written before issue #1605 that the
 * series cutover left alone (inactive, or its instance done), one whose tenant's cutover failed or has not run yet,
 * or one a previous release inserted.
 * `createTaskRecurrence` and the cutover always set the three together.
 */
export interface TaskRecurrence {
  itemId: string;
  mode: TaskRecurrenceMode;
  rule: TaskRecurrenceRule;
  active: boolean;
  seriesId: string | null;
  anchorDate: string | null;
  template: TaskRecurrenceTemplate | null;
}

/** The raw `task_recurrence` row shape this module reads back from Postgres; `anchor_date` is selected as text. */
type TaskRecurrenceDbRow = {
  item_id: string;
  mode: string;
  rule: unknown;
  active: boolean;
  series_id: string | null;
  anchor_date: string | null;
  template: unknown;
};

/** Parses a stored template; a malformed one is a corrupt row, not a template with defaults. */
export function parseTaskRecurrenceTemplate(raw: unknown): TaskRecurrenceTemplate {
  const parsed = templateSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Malformed task recurrence template in database row");
  return parsed.data;
}

function mapRow(row: TaskRecurrenceDbRow): TaskRecurrence {
  const mode = assertKnownValue(TASK_RECURRENCE_MODES, row.mode, "task recurrence mode");
  return {
    itemId: row.item_id,
    mode,
    rule: parseTaskRecurrenceRule(mode, row.rule),
    active: row.active,
    seriesId: row.series_id,
    anchorDate: row.anchor_date,
    template: row.template === null ? null : parseTaskRecurrenceTemplate(row.template),
  };
}

const COLUMNS = "item_id, mode, rule, active, series_id, anchor_date::text AS anchor_date, template";

export interface CreateTaskRecurrenceInput {
  itemId: string;
  mode: TaskRecurrenceMode;
  rule: TaskRecurrenceRule;
  /** The calendar day (`YYYY-MM-DD`) the series starts on. */
  anchorDate: string;
  template: TaskRecurrenceTemplate;
  active?: boolean;
}

/**
 * Creates a series (issue #1605): a new `series_id`, its anchor date and its template, pointing at `itemId`.
 * Not item/database state (no `properties`/`owner`), so it is written directly — same pattern as
 * `project_heartbeats` via schedulerStore.ts, not through the choke-point. The item's own `seriesId`,
 * `occurrenceDate` and `recurrence` properties are written by the Tasks module through the choke point.
 */
export async function createTaskRecurrence(
  client: Queryable,
  input: CreateTaskRecurrenceInput,
): Promise<TaskRecurrence> {
  const rule = parseTaskRecurrenceRule(input.mode, input.rule);
  const template = parseTaskRecurrenceTemplate(input.template);
  const { rows } = await client.query<TaskRecurrenceDbRow>(
    `INSERT INTO task_recurrence (item_id, mode, rule, active, series_id, anchor_date, template)
     VALUES ($1, $2, $3::jsonb, $4, gen_random_uuid(), $5::date, $6::jsonb) RETURNING ${COLUMNS}`,
    [input.itemId, input.mode, JSON.stringify(rule), input.active ?? true, input.anchorDate, JSON.stringify(template)],
  );
  return mapRow(requireSingleRow(rows, "task_recurrence row"));
}

/**
 * `forUpdate` row-locks the recurrence so two concurrent writers acting on it within their own
 * transactions serialize on the row: the second blocks until the first commits or rolls back,
 * then re-reads it. A plain read (no intent to mutate) should omit it.
 *
 * `forUpdate: true` requires a `PoolClient`, not the broader `Queryable` (`Pool | PoolClient`):
 * `FOR UPDATE` against a bare `Pool` acquires and immediately auto-commit-releases the lock on
 * that single statement, silently defeating the whole point of locking. These two overloads
 * make that a compile error instead of a runtime footgun.
 */
export function getTaskRecurrence(client: PoolClient, itemId: string, forUpdate: true): Promise<TaskRecurrence | null>;
export function getTaskRecurrence(client: Queryable, itemId: string, forUpdate?: false): Promise<TaskRecurrence | null>;
export async function getTaskRecurrence(
  client: Queryable,
  itemId: string,
  forUpdate = false,
): Promise<TaskRecurrence | null> {
  const { rows } = await client.query<TaskRecurrenceDbRow>(
    `SELECT ${COLUMNS} FROM task_recurrence WHERE item_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [itemId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * The series row of `seriesId` (issue #1605), with the same `forUpdate` contract and overloads as
 * `getTaskRecurrence`. Callers that also lock the series' instance item lock the item first
 * (docs/adr/2026-10-25-task-and-event-recurrence-model.md, "Lock order").
 */
export function getTaskRecurrenceBySeriesId(
  client: PoolClient,
  seriesId: string,
  forUpdate: true,
): Promise<TaskRecurrence | null>;
export function getTaskRecurrenceBySeriesId(
  client: Queryable,
  seriesId: string,
  forUpdate?: false,
): Promise<TaskRecurrence | null>;
export async function getTaskRecurrenceBySeriesId(
  client: Queryable,
  seriesId: string,
  forUpdate = false,
): Promise<TaskRecurrence | null> {
  const { rows } = await client.query<TaskRecurrenceDbRow>(
    `SELECT ${COLUMNS} FROM task_recurrence WHERE series_id = $1::uuid${forUpdate ? " FOR UPDATE" : ""}`,
    [seriesId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Points the series row at its new current instance (issue #1605): the row is moved, never duplicated. */
export async function moveTaskRecurrenceToItem(client: PoolClient, seriesId: string, itemId: string): Promise<void> {
  const result = await client.query(`UPDATE task_recurrence SET item_id = $2 WHERE series_id = $1::uuid`, [
    seriesId,
    itemId,
  ]);
  requireAffectedRows(result, "task_recurrence series row");
}

/**
 * Whether the Tasks database `databaseId` holds a non-deleted occurrence of `seriesId` dated `occurrenceDate`
 * (issue #1670). Run it while holding the series row lock, so a concurrent advance of the same series cannot
 * create the occurrence between this read and the caller's write.
 */
export async function hasSeriesOccurrence(
  client: PoolClient,
  databaseId: string,
  seriesId: string,
  occurrenceDate: string,
): Promise<boolean> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
     WHERE database_id = $1 AND deleted_at IS NULL
       AND properties->>'seriesId' = $2 AND properties->>'occurrenceDate' = $3
     LIMIT 1`,
    [databaseId, seriesId, occurrenceDate],
  );
  return rows.length > 0;
}

export async function setTaskRecurrenceActive(client: Queryable, itemId: string, active: boolean): Promise<void> {
  await client.query(`UPDATE task_recurrence SET active = $2 WHERE item_id = $1`, [itemId, active]);
}

/** Removes the recurrence rule of a hard-deleted item (trash purge, issue #675); zero rows is valid — most items have none. */
export async function deleteTaskRecurrence(client: Queryable, itemId: string): Promise<void> {
  await client.query(`DELETE FROM task_recurrence WHERE item_id = $1`, [itemId]);
}
