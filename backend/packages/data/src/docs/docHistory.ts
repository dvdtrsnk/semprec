import * as Y from "yjs";
import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import type { CreatedBy } from "../types.js";
import { loadDocWithClient, DEFAULT_HISTORY_RETENTION_MS } from "./docPersistence.js";

export { DEFAULT_HISTORY_RETENTION_MS };

/**
 * Written by a periodic squash job, not synchronously with every edit (issue #23,
 * point 6). Capturing the doc state and inserting its checkpoint row must happen in
 * the same transaction: reading the state in one transaction and writing the
 * checkpoint (with a fresh `now()` timestamp) in a second, separate one leaves a
 * window where a concurrent compaction can run in between — that compaction merges
 * away the very updates this squash's captured state is missing, then drops its own
 * (correct, older-timestamped) checkpoint, which this squash's later-but-stale
 * checkpoint would then incorrectly shadow in `openDocVersionAt`'s "most recent
 * checkpoint before `at`" lookup. `loadDocWithClient`'s `FOR UPDATE` locks make that
 * interleaving impossible by serializing this against `compact()` on the same doc.
 */
export async function squashDocHistory(pool: Pool, docId: string, createdBy: CreatedBy, retentionMs = DEFAULT_HISTORY_RETENTION_MS): Promise<void> {
  await withTransaction(pool, async (client) => {
    const doc = await loadDocWithClient(client, docId);
    const state = Buffer.from(Y.encodeStateAsUpdate(doc));
    await client.query(`INSERT INTO doc_snapshot_history (doc_id, state, expires_at, created_by) VALUES ($1, $2, now() + $3::interval, $4)`, [
      docId,
      state,
      `${retentionMs} milliseconds`,
      createdBy,
    ]);
  });
}

/**
 * Runs the squash for every existing doc — acceptable at the "1-2 users" scale this
 * system targets; see the compaction sweep for the pattern this mirrors. One doc
 * failing (a transient DB error, a corrupted update row) must not abort the sweep for
 * every doc after it in the list, so each is isolated and logged rather than thrown.
 */
export async function runHistorySquashSweep(pool: Pool, createdBy: CreatedBy = "system", retentionMs = DEFAULT_HISTORY_RETENTION_MS): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM docs`);
  let succeeded = 0;
  for (const row of rows) {
    try {
      await squashDocHistory(pool, row.id, createdBy, retentionMs);
      succeeded++;
    } catch (err) {
      console.error(`Failed to squash history for doc ${row.id}`, err);
    }
  }
  return succeeded;
}

export async function handleDocHistorySquashTask(pool: Pool): Promise<void> {
  await runHistorySquashSweep(pool);
}

/** Deletes expired checkpoints past their retention window — a cleanup job, not a business/tiering layer. */
export async function cleanupExpiredDocHistory(pool: Pool): Promise<number> {
  const { rowCount } = await pool.query(`DELETE FROM doc_snapshot_history WHERE expires_at < now()`);
  return rowCount ?? 0;
}

export async function handleDocHistoryCleanupTask(pool: Pool): Promise<void> {
  await cleanupExpiredDocHistory(pool);
}

/**
 * Reconstructs the doc as of `at`: the nearest checkpoint before `at`, plus the
 * remainder replayed from `doc_updates` between the checkpoint and `at` — never the
 * full log from document creation (issue #23, point 6).
 *
 * `compact()` (docPersistence.ts) always drops a checkpoint at the moment it merges
 * and deletes `doc_updates` rows. That's not quite enough on its own: a checkpoint
 * taken at T1 can still go stale for a query at T3 (T1 < T3) if a *later* compaction at
 * Tc > T3 has since run — that compaction deletes every `doc_updates` row pending at
 * Tc, including ones created between T1 and T3, leaving nothing to replay forward from
 * T1's checkpoint even though T3 has a checkpoint "before" it. The fix is the same in
 * both the no-checkpoint and stale-checkpoint case: any compaction that ran after `at`
 * (visible as `doc_snapshots.updated_at > at`, since compact() always bumps it) means
 * this reconstruction can't be trusted, so it raises `ValidationError` instead of
 * silently returning a doc missing content that genuinely existed at `at`.
 */
export async function openDocVersionAt(pool: Pool, docId: string, at: Date): Promise<Y.Doc> {
  return withTransaction(pool, async (client) => {
    const { rows: checkpointRows } = await client.query<{ state: Buffer }>(
      `SELECT state FROM doc_snapshot_history WHERE doc_id = $1 AND taken_at <= $2 ORDER BY taken_at DESC LIMIT 1`,
      [docId, at],
    );

    const doc = new Y.Doc();
    doc.gc = false;
    if (checkpointRows[0]) Y.applyUpdate(doc, checkpointRows[0].state);

    const { rows: updateRows } = await client.query<{ update: Buffer }>(
      `SELECT update FROM doc_updates WHERE doc_id = $1 AND created_at <= $2 ORDER BY id ASC`,
      [docId, at],
    );
    for (const row of updateRows) Y.applyUpdate(doc, row.update);

    // A compaction that ran after `at` is a red flag regardless of whether a checkpoint
    // was found: that compaction deletes every doc_updates row pending at the time it
    // runs, including ones created before `at` — the exact "checkpoint sh1 before `at`,
    // but a later compaction already swept away the updates between sh1 and `at`" gap.
    // If no compaction later than `at` has touched doc_snapshots, the checkpoint (or
    // lack of one) plus the surviving doc_updates rows above are the full picture.
    const { rows: snapshotRows } = await client.query<{ updated_at: Date }>(`SELECT updated_at FROM doc_snapshots WHERE doc_id = $1`, [docId]);
    if (snapshotRows[0] && snapshotRows[0].updated_at > at) {
      throw new ValidationError(
        `Cannot reconstruct doc ${docId} as of ${at.toISOString()}: a compaction after that time has already deleted doc_updates rows (and possibly superseded the checkpoint) that would cover it`,
        { docId, at: at.toISOString() },
      );
    }

    return doc;
  });
}
