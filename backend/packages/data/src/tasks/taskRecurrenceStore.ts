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

export async function getTaskRecurrence(client: Queryable, itemId: string): Promise<TaskRecurrence | null> {
  const { rows } = await client.query(`SELECT ${COLUMNS} FROM task_recurrence WHERE item_id = $1`, [itemId]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function setTaskRecurrenceActive(client: Queryable, itemId: string, active: boolean): Promise<void> {
  await client.query(`UPDATE task_recurrence SET active = $2 WHERE item_id = $1`, [itemId, active]);
}
