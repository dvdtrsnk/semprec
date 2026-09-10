import * as Y from "yjs";
import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { HistoryNotRetainedError, ValidationError } from "../errors.js";
import { resolveDocHistoryRetentionDays, retentionHours } from "./docHistoryConfig.js";

/** Deletes expired checkpoints past their retention window — a cleanup job, not a business/tiering layer.
 *  Never touches a NULL-expiry rolling baseline: `expires_at < now()` is NULL (falsy) for those rows. */
export async function cleanupExpiredDocHistory(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(`DELETE FROM doc_snapshot_history WHERE expires_at < now()`);
  return rowCount ?? 0;
}

export async function handleDocHistoryCleanupTask(pool: Pool): Promise<void> {
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
