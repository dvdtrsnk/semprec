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
 * The properties a series' occurrences are created from. `persistent` is legacy: stored templates keep the
 * boolean, new series store `false`, and no reader outside this module sees it (`publicTaskRecurrenceTemplate`).
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

export type PublicTaskRecurrenceTemplate = Omit<TaskRecurrenceTemplate, "persistent">;

export function publicTaskRecurrenceTemplate(template: TaskRecurrenceTemplate): PublicTaskRecurrenceTemplate {
  return {
    name: template.name,
    timeFrom: template.timeFrom,
    timeTo: template.timeTo,
    notifications: template.notifications,
    flagged: template.flagged,
    description: template.description,
  };
}

/**
 * Unlike `types.ts`'s loosely typed `TaskRecurrenceRow`, carries the validated, discriminated `TaskRecurrenceRule`.
 * `seriesId`, `anchorDate` and `template` are null together on a row without a series; `createTaskRecurrence`,
 * the only insert, sets all three.
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

type TaskRecurrenceDbRow = {
  item_id: string;
  mode: string;
  rule: unknown;
  active: boolean;
  series_id: string | null;
  anchor_date: string | null;
  template: unknown;
};

/** A malformed template is a corrupt row, not a template with defaults. */
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
  anchorDate: string;
  template: TaskRecurrenceTemplate;
  active?: boolean;
}

/**
 * Creates a series pointing at `itemId`. Not item state, so it is written directly rather than through the
 * choke point (like `project_heartbeats`); the item's own series properties are written by the Tasks module.
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
 * Starts a new series in the item's own inactive row (`item_id` is the primary key) with a new `series_id`;
 * old occurrences keep their `seriesId`. Call holding the row lock; fails without an inactive row.
 */
export async function restartTaskRecurrence(
  client: PoolClient,
  input: CreateTaskRecurrenceInput,
): Promise<TaskRecurrence> {
  const rule = parseTaskRecurrenceRule(input.mode, input.rule);
  const template = parseTaskRecurrenceTemplate(input.template);
  const result = await client.query<TaskRecurrenceDbRow>(
    `UPDATE task_recurrence
     SET mode = $2, rule = $3::jsonb, active = true, series_id = gen_random_uuid(), anchor_date = $4::date, template = $5::jsonb
     WHERE item_id = $1 AND NOT active RETURNING ${COLUMNS}`,
    [input.itemId, input.mode, JSON.stringify(rule), input.anchorDate, JSON.stringify(template)],
  );
  requireAffectedRows(result, "inactive task_recurrence row");
  return mapRow(requireSingleRow(result.rows, "inactive task_recurrence row"));
}

/** `anchorDate` moves the start. Call holding the series row lock. */
export async function replaceTaskRecurrenceRule(
  client: PoolClient,
  seriesId: string,
  input: { mode: TaskRecurrenceMode; rule: TaskRecurrenceRule; anchorDate?: string },
): Promise<TaskRecurrence> {
  const rule = parseTaskRecurrenceRule(input.mode, input.rule);
  const result = await client.query<TaskRecurrenceDbRow>(
    `UPDATE task_recurrence SET mode = $2, rule = $3::jsonb, active = true, anchor_date = COALESCE($4::date, anchor_date)
     WHERE series_id = $1::uuid RETURNING ${COLUMNS}`,
    [seriesId, input.mode, JSON.stringify(rule), input.anchorDate ?? null],
  );
  requireAffectedRows(result, "task_recurrence series row");
  return mapRow(requireSingleRow(result.rows, "task_recurrence series row"));
}

/** Call holding the series row lock, after locking the occurrences the series edit writes. */
export async function updateTaskRecurrenceTemplate(
  client: PoolClient,
  seriesId: string,
  template: TaskRecurrenceTemplate,
): Promise<void> {
  const parsed = parseTaskRecurrenceTemplate(template);
  const result = await client.query("UPDATE task_recurrence SET template = $2::jsonb WHERE series_id = $1::uuid", [
    seriesId,
    JSON.stringify(parsed),
  ]);
  requireAffectedRows(result, "task_recurrence series row");
}

/** The row stays, inactive, so the advance creates no next occurrence. */
export async function deactivateTaskRecurrenceSeries(client: PoolClient, seriesId: string): Promise<void> {
  const result = await client.query("UPDATE task_recurrence SET active = false WHERE series_id = $1::uuid", [seriesId]);
  requireAffectedRows(result, "task_recurrence series row");
}

/**
 * `forUpdate` row-locks the recurrence so concurrent writers serialize on it. It requires a `PoolClient`:
 * `FOR UPDATE` on a bare `Pool` auto-commits and releases the lock immediately, so the overloads make that a
 * compile error.
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

/** Same `forUpdate` contract as `getTaskRecurrence`. Lock order: the series' instance item before this row. */
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

export async function moveTaskRecurrenceToItem(client: PoolClient, seriesId: string, itemId: string): Promise<void> {
  const result = await client.query(`UPDATE task_recurrence SET item_id = $2 WHERE series_id = $1::uuid`, [
    seriesId,
    itemId,
  ]);
  requireAffectedRows(result, "task_recurrence series row");
}

/** Run holding the series row lock, so a concurrent advance cannot create the occurrence before the caller's write. */
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

/**
 * Turns the rule off because the series was trashed and records the instance it pointed at in
 * `trashed_active_item_id`. A rule already off is left alone. Returns whether this call turned it off. Call
 * holding the instance item locks (items before `task_recurrence`).
 */
export async function deactivateTaskRecurrenceForTrash(client: PoolClient, seriesId: string): Promise<boolean> {
  const result = await client.query(
    `UPDATE task_recurrence SET active = false, trashed_active_item_id = item_id
     WHERE series_id = $1::uuid AND active`,
    [seriesId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Turns the rule back on only when the restore reached the instance `deactivateTaskRecurrenceForTrash` recorded,
 * and clears the record; anything else changes nothing. Returns whether this call turned it on. Call holding the
 * instance item locks (items before `task_recurrence`).
 */
export async function reactivateTaskRecurrenceAfterTrash(
  client: PoolClient,
  seriesId: string,
  itemId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE task_recurrence SET active = true, trashed_active_item_id = NULL
     WHERE series_id = $1::uuid AND trashed_active_item_id = $2::uuid`,
    [seriesId, itemId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setTaskRecurrenceActive(client: Queryable, itemId: string, active: boolean): Promise<void> {
  await client.query(`UPDATE task_recurrence SET active = $2 WHERE item_id = $1`, [itemId, active]);
}
