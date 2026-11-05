import type { PoolClient } from "pg";
import { NotFoundError } from "../errors.js";
import { assertKnownValue } from "../dbRowValidation.js";

export const ITEM_AUTOMATION_STATUSES = ["pending", "done", "error", "locked", "notFound"] as const;
export type ItemAutomationStatus = (typeof ITEM_AUTOMATION_STATUSES)[number];

/** Stable, localizable reason an automation failed; the diagnostic `error` text is never returned to clients. */
export const ITEM_AUTOMATION_ERROR_CODES = [
  "budgetExceeded",
  "mediaUnreadable",
  "providerFailed",
  "unknown",
  "deleted",
  "sourceUnavailable",
  "rateLimited",
  "invalidResponse",
] as const;
export type ItemAutomationErrorCode = (typeof ITEM_AUTOMATION_ERROR_CODES)[number];
export const LIBRARY_AUTOMATION_SOURCES = ["openLibrary", "googleBooks", "tmdb"] as const;
export type LibraryAutomationSource = (typeof LIBRARY_AUTOMATION_SOURCES)[number];

export interface ItemAutomationRow {
  itemId: string;
  status: ItemAutomationStatus;
  error: string | null;
  errorCode: ItemAutomationErrorCode | null;
  source: LibraryAutomationSource | null;
  attempts: number;
  lastAttemptAt: string | null;
}

/** The raw `item_automation` row shape this module reads back from Postgres. */
type ItemAutomationDbRow = {
  item_id: string;
  status: string;
  error: string | null;
  error_code: string | null;
  source: string | null;
  attempts: number;
  last_attempt_at: Date | null;
};

function mapRow(row: ItemAutomationDbRow): ItemAutomationRow {
  return {
    itemId: row.item_id,
    status: assertKnownValue(ITEM_AUTOMATION_STATUSES, row.status, "item automation status"),
    error: row.error,
    errorCode:
      row.error_code === null
        ? null
        : assertKnownValue(ITEM_AUTOMATION_ERROR_CODES, row.error_code, "item automation error code"),
    source:
      row.source === null ? null : assertKnownValue(LIBRARY_AUTOMATION_SOURCES, row.source, "item automation source"),
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at ? row.last_attempt_at.toISOString() : null,
  };
}

const COLUMNS = "item_id, status, error, error_code, source, attempts, last_attempt_at";

/**
 * Idempotent: a second call for the same item is a no-op, so re-firing the onItemEvent
 * 'create' trigger (e.g. a retried heartbeatFireCore job) never resets an in-flight or
 * already-resolved row back to 'pending'.
 */
export async function ensureItemAutomation(client: PoolClient, itemId: string): Promise<ItemAutomationRow> {
  const inserted = await client.query<ItemAutomationDbRow>(
    `INSERT INTO item_automation (item_id) VALUES ($1) ON CONFLICT (item_id) DO NOTHING RETURNING ${COLUMNS}`,
    [itemId],
  );
  if (inserted.rows[0]) return mapRow(inserted.rows[0]);

  const existing = await getItemAutomation(client, itemId);
  if (!existing) throw new Error(`item_automation row for item ${itemId} vanished after a no-op conflict`);
  return existing;
}

export async function getItemAutomation(client: PoolClient, itemId: string): Promise<ItemAutomationRow | null> {
  const { rows } = await client.query<ItemAutomationDbRow>(
    `SELECT ${COLUMNS} FROM item_automation WHERE item_id = $1`,
    [itemId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Row-locking read used before a mutation, inside the caller's transaction — same pattern as `itemsStore.lockItemById`. */
export async function lockItemAutomation(client: PoolClient, itemId: string): Promise<ItemAutomationRow | null> {
  const { rows } = await client.query<ItemAutomationDbRow>(
    `SELECT ${COLUMNS} FROM item_automation WHERE item_id = $1 FOR UPDATE`,
    [itemId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** A `locked` row is never touched by the heartbeat, on success or failure — the WHERE guards both write paths below. */
export async function markItemAutomationDone(
  client: PoolClient,
  itemId: string,
  source: LibraryAutomationSource | null = null,
): Promise<void> {
  const result = await client.query(
    `UPDATE item_automation SET status = 'done', error = NULL, error_code = NULL, source = $2 WHERE item_id = $1 AND status != 'locked'`,
    [itemId, source],
  );
  if (result.rowCount === null || result.rowCount > 1) throw new Error("Unexpected automation completion count");
}

/** `attempts` is a cumulative counter across the whole history (including across daily retry batches), not reset per batch. */
export async function markItemAutomationError(
  client: PoolClient,
  itemId: string,
  error: string,
  errorCode: ItemAutomationErrorCode | null = null,
  source: LibraryAutomationSource | null = null,
): Promise<void> {
  const result = await client.query(
    `UPDATE item_automation SET status = 'error', error = $2, error_code = $3, source = $4, attempts = attempts + 1, last_attempt_at = now() WHERE item_id = $1 AND status != 'locked'`,
    [itemId, error, errorCode, source],
  );
  if (result.rowCount === null || result.rowCount > 1) throw new Error("Unexpected automation failure count");
}

export async function markItemAutomationNotFound(
  client: PoolClient,
  itemId: string,
  source: LibraryAutomationSource | null,
): Promise<void> {
  const result = await client.query(
    `UPDATE item_automation SET status = 'notFound', error = NULL, error_code = NULL, source = $2 WHERE item_id = $1 AND status != 'locked'`,
    [itemId, source],
  );
  if (result.rowCount === null || result.rowCount > 1) throw new Error("Unexpected automation not-found count");
}

/**
 * Opens one processing attempt of a job that counts every attempt, not only failed ones (issue
 * #248's transcription pipeline): moves the row back to `pending`, increments the cumulative
 * `attempts` and stamps `last_attempt_at`, keeping `error` until a later success clears it.
 * Returns the updated row, or `null` when the row is `locked` or absent — either way the caller
 * must not process the item.
 */
export async function startItemAutomationAttempt(
  client: PoolClient,
  itemId: string,
): Promise<ItemAutomationRow | null> {
  const result = await client.query<ItemAutomationDbRow>(
    `UPDATE item_automation SET status = 'pending', attempts = attempts + 1, last_attempt_at = now()
     WHERE item_id = $1 AND status != 'locked' RETURNING ${COLUMNS}`,
    [itemId],
  );
  if (result.rowCount === 0 || !result.rows[0]) return null;
  return mapRow(result.rows[0]);
}

/**
 * Records a failed attempt's reason without counting it again (`startItemAutomationAttempt`
 * already did): `status` stays `pending` while retries remain, and becomes `error` once the
 * failure is permanent. `errorCode` replaces the stored code (`null` clears it). Returns whether a row was written — `false` when the row is `locked`
 * or absent.
 */
export async function recordItemAutomationFailure(
  client: PoolClient,
  itemId: string,
  error: string,
  status: Extract<ItemAutomationStatus, "pending" | "error">,
  errorCode: ItemAutomationErrorCode | null = null,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE item_automation SET status = $3, error = $2, error_code = $4 WHERE item_id = $1 AND status != 'locked'`,
    [itemId, error, status, errorCode],
  );
  return result.rowCount === 1;
}

/**
 * The one status transition the heartbeat may never make on its own — settable only by
 * the user (or an authorized agent). Unlocking only transitions a row that is actually
 * `'locked'` (guarded in the WHERE clause, not just by convention): without this, calling
 * this with `locked: false` on a `'done'`/`'error'` row it was never asked to unlock would
 * overwrite that status with `'pending'`, misrepresenting a settled outcome. A no-op call
 * (locking an already-locked row, or unlocking a row that isn't locked) returns the row
 * unchanged instead of erroring.
 */
export async function setItemAutomationLocked(
  client: PoolClient,
  itemId: string,
  locked: boolean,
): Promise<ItemAutomationRow> {
  const { rows } = await client.query<ItemAutomationDbRow>(
    `UPDATE item_automation SET status = $2 WHERE item_id = $1 AND status ${locked ? "!=" : "="} 'locked' RETURNING ${COLUMNS}`,
    [itemId, locked ? "locked" : "pending"],
  );
  if (rows[0]) return mapRow(rows[0]);

  const existing = await getItemAutomation(client, itemId);
  if (!existing) throw new NotFoundError(`item_automation row for item ${itemId} not found`);
  return existing;
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
export async function listErroredItemAutomationForDatabases(
  client: PoolClient,
  databaseIds: string[],
): Promise<ItemAutomationRow[]> {
  if (databaseIds.length === 0) return [];
  const { rows } = await client.query<ItemAutomationDbRow>(
    `SELECT ia.item_id, ia.status, ia.error, ia.error_code, ia.source, ia.attempts, ia.last_attempt_at
     FROM item_automation ia
     JOIN items i ON i.id = ia.item_id
     WHERE ia.status = 'error' AND i.database_id = ANY($1::uuid[]) AND i.deleted_at IS NULL`,
    [databaseIds],
  );
  return rows.map(mapRow);
}

export async function listRetryableLibraryAutomationForDatabases(
  client: PoolClient,
  databaseIds: string[],
): Promise<ItemAutomationRow[]> {
  if (databaseIds.length === 0) return [];
  const { rows } = await client.query<ItemAutomationDbRow>(
    `SELECT ia.item_id, ia.status, ia.error, ia.error_code, ia.source, ia.attempts, ia.last_attempt_at
     FROM item_automation ia JOIN items i ON i.id = ia.item_id AND i.tenant_id = ia.tenant_id
     WHERE ia.tenant_id = app_tenant_default() AND ia.status IN ('error', 'notFound')
       AND i.database_id = ANY($1::uuid[]) AND i.deleted_at IS NULL`,
    [databaseIds],
  );
  return rows.map(mapRow);
}

/** Removes the automation state of a hard-deleted item (trash purge, issue #675); zero rows is valid — most items have none. */
export async function deleteItemAutomation(client: PoolClient, itemId: string): Promise<void> {
  await client.query(`DELETE FROM item_automation WHERE item_id = $1`, [itemId]);
}

interface ItemAutomationRead {
  status: "pending" | "found" | "notFound" | "error" | "locked";
  attempts: number;
  lastAttemptAt: string | null;
  errorCode: ItemAutomationErrorCode | null;
  source: LibraryAutomationSource | null;
  nextAttemptAt: string | null;
}

/** Reads automation and its library retry schedule for a page of tenant-visible items. */
export async function readAutomationForItems(
  client: PoolClient,
  itemIds: string[],
): Promise<Map<string, ItemAutomationRead>> {
  if (itemIds.length === 0) return new Map();
  const { rows } = await client.query<ItemAutomationDbRow & { next_attempt_at: Date | null }>(
    `SELECT ia.item_id, ia.status, ia.error, ia.error_code, ia.source, ia.attempts, ia.last_attempt_at,
            heartbeat.next_fire_at AS next_attempt_at
     FROM item_automation ia
     JOIN items i ON i.tenant_id = ia.tenant_id AND i.id = ia.item_id
     LEFT JOIN LATERAL (
       SELECT h.next_fire_at FROM project_heartbeats h
       WHERE h.tenant_id = ia.tenant_id AND h.action_id = $2 AND h.action_config->>'databaseId' = i.database_id::text
       ORDER BY h.id LIMIT 1
     ) heartbeat ON true
     WHERE ia.tenant_id = app_tenant_default() AND ia.item_id = ANY($1::uuid[])`,
    [itemIds, "core.libraryMetadataRetrySweep"],
  );
  return new Map(
    rows.map((row) => {
      const value = mapRow(row);
      return [
        row.item_id,
        {
          status: value.status === "done" ? ("found" as const) : value.status,
          attempts: value.attempts,
          lastAttemptAt: value.lastAttemptAt,
          errorCode: value.errorCode,
          source: value.source,
          nextAttemptAt:
            value.status === "done" || value.status === "locked" ? null : (row.next_attempt_at?.toISOString() ?? null),
        },
      ];
    }),
  );
}
