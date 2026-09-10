import * as Y from "yjs";
import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { HistoryNotRetainedError, ValidationError } from "../errors.js";
import { resolveDocHistoryRetentionDays, retentionHours } from "./docHistoryConfig.js";

/**
 * Re-baselines one document's history at the retention cutoff (issue #86). Issue #216
 * mirrors every append into `doc_history_updates` and never deletes it — this is the
 * cleanup that actually bounds that log's growth, deferred out of #216's scope.
 *
 * `cutoff = transaction_timestamp() - make_interval(hours => 24 * retentionDays)`, the exact
 * cutoff `openDocVersionAt` already uses. The document's exact state at `cutoff` is
 * reconstructed from its current rolling baseline plus `doc_history_updates` (the same
 * checkpoint-then-replay contract as `openDocVersionAt`), then installed as a new full,
 * NULL-expiry baseline checkpoint at `represented_at = cutoff`. Only after that checkpoint
 * has been written does this advance `docs.history_available_from` to `cutoff` and delete
 * the `doc_history_updates` rows and older checkpoints (including the preceding NULL-expiry
 * baseline) the new baseline makes redundant — every later update/checkpoint required to
 * reconstruct anything at or after `cutoff` is left untouched.
 *
 * Runs in one transaction under the same `doc_snapshots` row lock `loadDocWithClient`
 * (docPersistence.ts) takes for append/compaction, so this can never observe, or race
 * with, a concurrent append or compaction on the same doc.
 *
 * A no-op — retaining the existing baseline and availability — when `cutoff` doesn't
 * strictly advance past the doc's current `history_available_from` (including a doc with no
 * history yet, or one whose retention window hasn't produced a new cutoff since the last
 * re-baseline). Returns whether a re-baseline was performed.
 */
export async function rebaselineDocHistory(
  pool: Pool,
  docId: string,
  retentionDays = resolveDocHistoryRetentionDays(),
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    // The document lock: the same `doc_snapshots` row-per-doc FOR UPDATE that
    // `loadDocWithClient` takes, serializing this against append/compaction on this doc.
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
       WHERE doc_id = $1 AND update_id > $2 AND created_at <= $3
       ORDER BY created_at ASC, update_id ASC`,
      [docId, checkpoint.through_update_id, cutoff],
    );
    for (const row of historyRows) Y.applyUpdate(doc, row.update);

    // The greatest update_id whose created_at <= cutoff, or the preceding baseline's own
    // boundary when nothing new was replayed forward from it.
    const throughUpdateId =
      historyRows.length > 0 ? historyRows[historyRows.length - 1]!.update_id : checkpoint.through_update_id;
    const state = Buffer.from(Y.encodeStateAsUpdate(doc));

    await client.query(
      `INSERT INTO doc_snapshot_history (doc_id, state, through_update_id, represented_at, expires_at, created_by)
       VALUES ($1, $2, $3, $4::timestamptz, NULL, 'system')`,
      [docId, state, throughUpdateId, cutoff],
    );
    await client.query(`UPDATE docs SET history_available_from = $2 WHERE id = $1`, [docId, cutoff]);

    // Safe only now that the replacement baseline above is in place: openDocVersionAt never
    // opens a timestamp before history_available_from, which was just advanced to `cutoff`,
    // so every checkpoint represented before `cutoff` — including the preceding NULL-expiry
    // baseline — and every history update through the new boundary is unreachable and
    // redundant.
    await client.query(`DELETE FROM doc_snapshot_history WHERE doc_id = $1 AND represented_at < $2`, [docId, cutoff]);
    await client.query(`DELETE FROM doc_history_updates WHERE doc_id = $1 AND update_id <= $2`, [
      docId,
      throughUpdateId,
    ]);

    return true;
  });
}

/**
 * Runs the retention re-baseline for every existing doc — acceptable at the "1-2 users"
 * scale this system targets; see the compaction sweep for the pattern this mirrors. One doc
 * failing must not abort the sweep for every doc after it in the list, so each is isolated
 * and logged rather than thrown.
 */
export async function runDocHistoryRetentionSweep(
  pool: Pool,
  retentionDays = resolveDocHistoryRetentionDays(),
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM docs`);
  let succeeded = 0;
  for (const row of rows) {
    try {
      if (await rebaselineDocHistory(pool, row.id, retentionDays)) succeeded++;
    } catch (err) {
      console.error(`Failed to rebaseline history for doc ${row.id}`, err);
    }
  }
  return succeeded;
}

/** Deletes expired checkpoints past their retention window — a cleanup job, not a business/tiering layer.
 *  Never touches a NULL-expiry rolling baseline: `expires_at < now()` is NULL (falsy) for those rows.
 *  Subordinate to `rebaselineDocHistory`/`runDocHistoryRetentionSweep`: an expiring compaction
 *  checkpoint is always safe to delete regardless of order, since an earlier NULL-expiry
 *  baseline is always present to reconstruct from instead (see compact()'s docPersistence.ts
 *  comment) — this never removes a checkpoint still required for reconstruction inside the
 *  retained interval. */
export async function cleanupExpiredDocHistory(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(`DELETE FROM doc_snapshot_history WHERE expires_at < now()`);
  return rowCount ?? 0;
}

export async function handleDocHistoryCleanupTask(pool: Pool): Promise<void> {
  await runDocHistoryRetentionSweep(pool);
  await cleanupExpiredDocHistory(pool);
}

/**
 * Reconstructs the doc as of `at` (issue #216's selection contract): the latest checkpoint
 * whose `represented_at <= at`, replayed forward through `doc_history_updates` rows with
 * `update_id > through_update_id` and `created_at <= at`, in `(created_at, update_id)`
 * order (equal timestamps break ties by id).
 *
 * Unlike the pre-#216 reader, this never has to refuse a reconstruction because a later
 * compaction deleted something it needed: `doc_history_updates` is mirrored on every append
 * and never touched by compaction, so any timestamp inside the retained window can always be
 * replayed forward from its nearest checkpoint (the new-doc baseline, a compaction
 * checkpoint, or the populated-upgrade cutover baseline).
 *
 * - A future `at` raises `ValidationError` (400 `validation_failed`).
 * - An `at` before `docs.history_available_from` or before the configured retention cutoff
 *   raises `HistoryNotRetainedError` (410 `history_not_retained`) — a stable explicit
 *   "not retained" result, not a misleading partial document.
 * - `at` between doc creation and the first update returns the empty initial doc, via the
 *   new-doc baseline checkpoint (`through_update_id = 0`, nothing yet to replay).
 * - A nonfuture `at` at/after the latest update returns the latest state, because replay
 *   naturally includes every history update through `at`.
 */
export async function openDocVersionAt(
  pool: Pool,
  docId: string,
  at: Date,
  retentionDays = resolveDocHistoryRetentionDays(),
): Promise<Y.Doc> {
  return withTransaction(pool, async (client) => {
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
      throw new ValidationError(`Doc ${docId} does not exist`, { docId });
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

    const doc = new Y.Doc();
    doc.gc = false;
    Y.applyUpdate(doc, checkpoint.state);

    const { rows: historyRows } = await client.query<{ update: Buffer }>(
      `SELECT update FROM doc_history_updates
       WHERE doc_id = $1 AND update_id > $2 AND created_at <= $3
       ORDER BY created_at ASC, update_id ASC`,
      [docId, checkpoint.through_update_id, at],
    );
    for (const row of historyRows) Y.applyUpdate(doc, row.update);

    return doc;
  });
}
