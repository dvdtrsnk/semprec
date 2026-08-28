import type { PoolClient } from "pg";
import type { Queryable } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { parseTaskRecurrenceRule, TASK_RECURRENCE_MODES, type TaskRecurrenceMode, type TaskRecurrenceRule } from "./taskRecurrenceRule.js";

/**
 * Not `types.ts`'s `TaskRecurrenceRow` (which keeps `rule` as a loosely-typed jsonb bag,
 * matching how other Row types like `PropertyRow.config` stay untyped at that layer) — this
 * store's callers (advanceTaskRecurrence.ts) need the already-validated, discriminated
 * `TaskRecurrenceRule`, not a round-trip cast back through `unknown`.
 */
export interface TaskRecurrence {
  itemId: string;
  mode: TaskRecurrenceMode;
  rule: TaskRecurrenceRule;
  active: boolean;
}

function mapRow(row: { item_id: string; mode: string; rule: unknown; active: boolean }): TaskRecurrence {
  const mode = assertKnownValue(TASK_RECURRENCE_MODES, row.mode, "task recurrence mode");
  return {
    itemId: row.item_id,
    mode,
    rule: parseTaskRecurrenceRule(mode, row.rule),
    active: row.active,
  };
}

const COLUMNS = "item_id, mode, rule, active";

export interface CreateTaskRecurrenceInput {
  itemId: string;
  mode: TaskRecurrenceMode;
  rule: TaskRecurrenceRule;
  active?: boolean;
}

/** Not item/database state (no `properties`/`owner`), so it is written directly — same pattern as `project_heartbeats` via schedulerStore.ts, not through the choke-point. */
export async function createTaskRecurrence(client: Queryable, input: CreateTaskRecurrenceInput): Promise<TaskRecurrence> {
  const rule = parseTaskRecurrenceRule(input.mode, input.rule);
  const { rows } = await client.query(
    `INSERT INTO task_recurrence (item_id, mode, rule, active) VALUES ($1, $2, $3::jsonb, $4) RETURNING ${COLUMNS}`,
    [input.itemId, input.mode, JSON.stringify(rule), input.active ?? true],
  );
  return mapRow(rows[0]);
}

/**
 * `forUpdate` row-locks the recurrence so two concurrent advances of the same task can't
 * both read `active: true` and both proceed — the second blocks until the first's
 * transaction commits (at which point `active` has flipped to `false`, so it correctly
 * no-ops) or rolls back (at which point it re-reads the original, still-active row). Pass
 * `true` from any caller that's about to act on `active` within its own transaction, e.g.
 * `advanceTaskRecurrence`; a plain read (no intent to mutate) should omit it.
 *
 * `forUpdate: true` requires a `PoolClient`, not the broader `Queryable` (`Pool | PoolClient`):
 * `FOR UPDATE` against a bare `Pool` acquires and immediately auto-commit-releases the lock on
 * that single statement, silently defeating the whole point of locking. These two overloads
 * make that a compile error instead of a runtime footgun.
 */
export function getTaskRecurrence(client: PoolClient, itemId: string, forUpdate: true): Promise<TaskRecurrence | null>;
export function getTaskRecurrence(client: Queryable, itemId: string, forUpdate?: false): Promise<TaskRecurrence | null>;
export async function getTaskRecurrence(client: Queryable, itemId: string, forUpdate = false): Promise<TaskRecurrence | null> {
  const { rows } = await client.query(`SELECT ${COLUMNS} FROM task_recurrence WHERE item_id = $1${forUpdate ? " FOR UPDATE" : ""}`, [itemId]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function setTaskRecurrenceActive(client: Queryable, itemId: string, active: boolean): Promise<void> {
  await client.query(`UPDATE task_recurrence SET active = $2 WHERE item_id = $1`, [itemId, active]);
}
