import type { PoolClient } from "pg";
import { NotFoundError } from "../errors.js";
import { assertKnownValue } from "../dbRowValidation.js";

export const ITEM_AUTOMATION_STATUSES = ["pending", "done", "error", "locked"] as const;
export type ItemAutomationStatus = (typeof ITEM_AUTOMATION_STATUSES)[number];

export interface ItemAutomationRow {
  itemId: string;
  status: ItemAutomationStatus;
  error: string | null;
  attempts: number;
  lastAttemptAt: string | null;
}

function mapRow(row: { item_id: string; status: string; error: string | null; attempts: number; last_attempt_at: Date | null }): ItemAutomationRow {
  return {
    itemId: row.item_id,
    status: assertKnownValue(ITEM_AUTOMATION_STATUSES, row.status, "item automation status"),
    error: row.error,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at ? row.last_attempt_at.toISOString() : null,
  };
}

const COLUMNS = "item_id, status, error, attempts, last_attempt_at";

/**
 * Idempotent: a second call for the same item is a no-op, so re-firing the onItemEvent
 * 'create' trigger (e.g. a retried heartbeatFire job) never resets an in-flight or
 * already-resolved row back to 'pending'.
 */
export async function ensureItemAutomation(client: PoolClient, itemId: string): Promise<ItemAutomationRow> {
  const inserted = await client.query(`INSERT INTO item_automation (item_id) VALUES ($1) ON CONFLICT (item_id) DO NOTHING RETURNING ${COLUMNS}`, [
    itemId,
  ]);
  if (inserted.rows[0]) return mapRow(inserted.rows[0]);

  const existing = await getItemAutomation(client, itemId);
  if (!existing) throw new Error(`item_automation row for item ${itemId} vanished after a no-op conflict`);
  return existing;
}

export async function getItemAutomation(client: PoolClient, itemId: string): Promise<ItemAutomationRow | null> {
  const { rows } = await client.query(`SELECT ${COLUMNS} FROM item_automation WHERE item_id = $1`, [itemId]);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** A `locked` row is never touched by the heartbeat, on success or failure — the WHERE guards both write paths below. */
export async function markItemAutomationDone(client: PoolClient, itemId: string): Promise<void> {
  await client.query(`UPDATE item_automation SET status = 'done', error = NULL WHERE item_id = $1 AND status != 'locked'`, [itemId]);
}

/** `attempts` is a cumulative counter across the whole history (including across daily retry batches), not reset per batch. */
export async function markItemAutomationError(client: PoolClient, itemId: string, error: string): Promise<void> {
  await client.query(
    `UPDATE item_automation SET status = 'error', error = $2, attempts = attempts + 1, last_attempt_at = now() WHERE item_id = $1 AND status != 'locked'`,
    [itemId, error],
  );
}

/** The one status transition the heartbeat may never make on its own — settable only by the user (or an authorized agent). */
export async function setItemAutomationLocked(client: PoolClient, itemId: string, locked: boolean): Promise<ItemAutomationRow> {
  const { rows } = await client.query(`UPDATE item_automation SET status = $2 WHERE item_id = $1 RETURNING ${COLUMNS}`, [
    itemId,
    locked ? "locked" : "pending",
  ]);
  if (!rows[0]) throw new NotFoundError(`item_automation row for item ${itemId} not found`);
  return mapRow(rows[0]);
}

/**
 * Rows the daily retry sweep re-enqueues: every item under one of the given databases
 * whose whole 3-attempt batch has failed. Joins `items` to scope by database, since
 * `item_automation` itself carries no database_id (it is deliberately generic, not
 * library-specific) — `items.id` is unique across all partitions, so the join needs no
 * `database_id` predicate of its own, same as `itemsStore.getItemsByIds`. Excludes a
 * soft-deleted item: retrying metadata for something the user deleted would just fail (or
 * silently no-op) forever, spending a fresh 3-attempt batch every day for nothing.
 */
export async function listErroredItemAutomationForDatabases(client: PoolClient, databaseIds: string[]): Promise<ItemAutomationRow[]> {
  if (databaseIds.length === 0) return [];
  const { rows } = await client.query(
    `SELECT ia.item_id, ia.status, ia.error, ia.attempts, ia.last_attempt_at
     FROM item_automation ia
     JOIN items i ON i.id = ia.item_id
     WHERE ia.status = 'error' AND i.database_id = ANY($1::uuid[]) AND i.deleted_at IS NULL`,
    [databaseIds],
  );
  return rows.map(mapRow);
}
