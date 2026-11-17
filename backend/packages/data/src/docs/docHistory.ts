import * as Y from "yjs";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { HistoryNotRetainedError, NotFoundError, ValidationError } from "../errors.js";
import { resolveDocHistoryRetentionDays, retentionHours } from "./docHistoryConfig.js";
import { logger } from "./logger.js";
import { assertSweepNotFailedEntirely, type SweepOutcome } from "./sweepOutcome.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";

/**
 * Bounds `doc_history_updates` growth: folds the state at the retention cutoff into a new NULL-expiry baseline, then
 * advances `history_available_from` and deletes what the baseline makes redundant.
 *
 * The folded boundary is chosen by `update_id` contiguity, not timestamp: `created_at` is the appending transaction's
 * start time while `update_id` is assigned at insert, so a lower id can carry a later `created_at`. Folding by
 * timestamp could delete an unfolded lower-id row that `openDocVersionAt` (which reads `update_id >
 * through_update_id`) could never replay. Rows past the gap stay and are replayed; Yjs updates commute.
 *
 * Holds the same `doc_snapshots` row lock as append/compaction. Returns false (no-op) when the cutoff does not advance.
 */
export async function rebaselineDocHistory(
  pool: Pool,
  docId: string,
  retentionDays = resolveDocHistoryRetentionDays(),
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    // Same lock as `loadDocWithClient`: serializes against append/compaction.
    await client.query(`SELECT 1 FROM doc_snapshots WHERE doc_id = $1 FOR UPDATE`, [docId]);

    const { rows: docRows } = await client.query<{ history_available_from: Date | null }>(
      `SELECT history_available_from FROM docs WHERE id = $1`,
      [docId],
    );
    const docRow = docRows[0];
    if (!docRow || docRow.history_available_from === null) return false;

    const { rows: cutoffRows } = await client.query<{ cutoff: Date }>(
      `SELECT transaction_timestamp() - make_interval(hours => $1::int) AS cutoff`,
      [retentionHours(retentionDays)],
    );
    const cutoff = cutoffRows[0]!.cutoff;

    if (cutoff.getTime() <= docRow.history_available_from.getTime()) return false;

    const { rows: checkpointRows } = await client.query<{
      through_update_id: string;
      represented_at: Date;
      state: Buffer;
    }>(
      `SELECT through_update_id, represented_at, state FROM doc_snapshot_history
       WHERE doc_id = $1 AND represented_at <= $2
       ORDER BY represented_at DESC, through_update_id DESC LIMIT 1`,
      [docId, cutoff],
    );
    const checkpoint = checkpointRows[0];
    if (!checkpoint) return false;

    const doc = new Y.Doc();
    doc.gc = false;
    Y.applyUpdate(doc, checkpoint.state);

    const { rows: historyRows } = await client.query<{ update_id: string; update: Buffer }>(
      `SELECT update_id, update FROM doc_history_updates
       WHERE doc_id = $1 AND update_id > $2
         AND update_id < COALESCE(
           (SELECT min(update_id) FROM doc_history_updates
            WHERE doc_id = $1 AND update_id > $2 AND created_at > $3),
           9223372036854775807)
       ORDER BY update_id ASC`,
      [docId, checkpoint.through_update_id, cutoff],
    );
    for (const row of historyRows) Y.applyUpdate(doc, row.update);

    const throughUpdateId =
      historyRows.length > 0 ? historyRows[historyRows.length - 1]!.update_id : checkpoint.through_update_id;
    const state = Buffer.from(Y.encodeStateAsUpdate(doc));

    await client.query(
      `INSERT INTO doc_snapshot_history (doc_id, state, through_update_id, represented_at, expires_at, created_by)
       VALUES ($1, $2, $3, $4::timestamptz, NULL, 'system')`,
      [docId, state, throughUpdateId, cutoff],
    );
    await client.query(`UPDATE docs SET history_available_from = $2 WHERE id = $1`, [docId, cutoff]);

    // Safe only after the new baseline exists and `history_available_from` advanced: these rows are now unreachable.
    await client.query(`DELETE FROM doc_snapshot_history WHERE doc_id = $1 AND represented_at < $2`, [docId, cutoff]);
    await client.query(`DELETE FROM doc_history_updates WHERE doc_id = $1 AND update_id <= $2`, [
      docId,
      throughUpdateId,
    ]);

    return true;
  });
}

/** Per-doc failures are logged, not thrown, so one doc cannot abort the sweep. */
export async function runDocHistoryRetentionSweep(
  pool: Pool,
  retentionDays = resolveDocHistoryRetentionDays(),
): Promise<SweepOutcome & { rebaselined: number }> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM docs`);
  let succeeded = 0;
  let failed = 0;
  let rebaselined = 0;
  for (const row of rows) {
    try {
      if (await rebaselineDocHistory(pool, row.id, retentionDays)) rebaselined++;
      succeeded++;
    } catch (err) {
      failed++;
      logger.error({ err, docId: row.id }, "Failed to rebaseline doc history");
    }
  }
  return { succeeded, failed, rebaselined };
}

/**
 * Never touches a NULL-expiry baseline (`expires_at < now()` is NULL for those). An expiring compaction checkpoint is
 * always safe to delete because an earlier NULL-expiry baseline remains to reconstruct from.
 */
export async function cleanupExpiredDocHistory(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(`DELETE FROM doc_snapshot_history WHERE expires_at < now()`);
  return rowCount ?? 0;
}

export async function handleDocHistoryCleanupTask(pool: Pool): Promise<void> {
  await forEachActiveTenant(pool, async () => {
    const outcome = await runDocHistoryRetentionSweep(pool);
    await cleanupExpiredDocHistory(pool);
    assertSweepNotFailedEntirely("docHistoryCleanup", outcome);
  });
}

/**
 * Latest checkpoint at or before `at`, replayed forward through `doc_history_updates`. Compaction never touches that
 * log, so any `at` inside the retained window is reconstructible. Outside it: `HistoryNotRetainedError` (410), never a
 * partial document.
 */
export async function openDocVersionAt(
  pool: Pool,
  docId: string,
  at: Date,
  retentionDays = resolveDocHistoryRetentionDays(),
): Promise<Y.Doc> {
  return withTransaction(pool, (client) => openDocVersionAtWithClient(client, docId, at, retentionDays));
}

/** Exported so the page restore can refuse early, before replaying any history. */
export async function assertDocVersionReadable(
  client: PoolClient,
  docId: string,
  at: Date,
  retentionDays = resolveDocHistoryRetentionDays(),
): Promise<void> {
  const { rows: nowRows } = await client.query<{ now: Date }>(`SELECT transaction_timestamp() AS now`);
  const now = nowRows[0]!.now;
  if (at.getTime() > now.getTime()) {
    throw new ValidationError(`Cannot open doc ${docId} at a future timestamp ${at.toISOString()}`, {
      docId,
      at: at.toISOString(),
    });
  }

  const { rows: docRows } = await client.query<{ history_available_from: Date | null }>(
    `SELECT history_available_from FROM docs WHERE id = $1`,
    [docId],
  );
  const docRow = docRows[0];
  if (!docRow) {
    throw new NotFoundError(`Doc ${docId} does not exist`, { docId });
  }

  const { rows: cutoffRows } = await client.query<{ cutoff: Date }>(
    `SELECT transaction_timestamp() - make_interval(hours => $1::int) AS cutoff`,
    [retentionHours(retentionDays)],
  );
  const cutoff = cutoffRows[0]!.cutoff;

  if (
    docRow.history_available_from === null ||
    at.getTime() < docRow.history_available_from.getTime() ||
    at.getTime() < cutoff.getTime()
  ) {
    throw new HistoryNotRetainedError(docId, at);
  }
}

export async function readCheckpointAtOrBefore(
  client: PoolClient,
  docId: string,
  at: Date,
): Promise<{ throughUpdateId: string; state: Buffer }> {
  const { rows: checkpointRows } = await client.query<{
    through_update_id: string;
    represented_at: Date;
    state: Buffer;
  }>(
    `SELECT through_update_id, represented_at, state FROM doc_snapshot_history
       WHERE doc_id = $1 AND represented_at <= $2
       ORDER BY represented_at DESC, through_update_id DESC LIMIT 1`,
    [docId, at],
  );
  const checkpoint = checkpointRows[0];
  if (!checkpoint) {
    throw new HistoryNotRetainedError(docId, at);
  }
  return { throughUpdateId: checkpoint.through_update_id, state: checkpoint.state };
}

/**
 * Same checkpoint as `readCheckpointAtOrBefore` but without the state, so a caller with a byte budget can refuse an
 * oversized checkpoint before materializing it. Not exported from the package barrel.
 */
export async function readCheckpointHeadAtOrBefore(
  client: PoolClient,
  docId: string,
  at: Date,
): Promise<{ id: string; throughUpdateId: string; stateBytes: number }> {
  const { rows } = await client.query<{ id: string; through_update_id: string; state_bytes: number }>(
    `SELECT id, through_update_id, octet_length(state)::int AS state_bytes FROM doc_snapshot_history
       WHERE doc_id = $1 AND represented_at <= $2
       ORDER BY represented_at DESC, through_update_id DESC LIMIT 1`,
    [docId, at],
  );
  const head = rows[0];
  if (!head) {
    throw new HistoryNotRetainedError(docId, at);
  }
  return { id: head.id, throughUpdateId: head.through_update_id, stateBytes: head.state_bytes };
}

/** Must run in the same snapshot as `readCheckpointHeadAtOrBefore`. */
export async function readCheckpointState(client: PoolClient, checkpointId: string): Promise<Buffer> {
  const { rows } = await client.query<{ state: Buffer }>(`SELECT state FROM doc_snapshot_history WHERE id = $1`, [
    checkpointId,
  ]);
  const row = rows[0];
  if (!row) throw new Error("Checkpoint row disappeared inside its own snapshot");
  return row.state;
}

/** On the caller's client so a writing caller (page restore) reads history in its own transaction. */
export async function openDocVersionAtWithClient(
  client: PoolClient,
  docId: string,
  at: Date,
  retentionDays = resolveDocHistoryRetentionDays(),
): Promise<Y.Doc> {
  await assertDocVersionReadable(client, docId, at, retentionDays);

  const checkpoint = await readCheckpointAtOrBefore(client, docId, at);

  const doc = new Y.Doc();
  doc.gc = false;
  Y.applyUpdate(doc, checkpoint.state);

  const { rows: historyRows } = await client.query<{ update: Buffer }>(
    `SELECT update FROM doc_history_updates
       WHERE doc_id = $1 AND update_id > $2 AND created_at <= $3
       ORDER BY update_id ASC`,
    [docId, checkpoint.throughUpdateId, at],
  );
  for (const row of historyRows) Y.applyUpdate(doc, row.update);

  return doc;
}
