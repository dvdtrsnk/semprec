import * as Y from "yjs";
import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import type { CreatedBy } from "../types.js";
import { loadDoc, DEFAULT_HISTORY_RETENTION_MS } from "./docPersistence.js";

export { DEFAULT_HISTORY_RETENTION_MS };

/** Written by a periodic squash job, not synchronously with every edit (issue #23, point 6). */
export async function squashDocHistory(pool: Pool, docId: string, createdBy: CreatedBy, retentionMs = DEFAULT_HISTORY_RETENTION_MS): Promise<void> {
  const doc = await loadDoc(pool, docId);
  const state = Buffer.from(Y.encodeStateAsUpdate(doc));
  await withTransaction(pool, (client) =>
    client.query(`INSERT INTO doc_snapshot_history (doc_id, state, expires_at, created_by) VALUES ($1, $2, now() + $3::interval, $4)`, [
      docId,
      state,
      `${retentionMs} milliseconds`,
      createdBy,
    ]),
  );
}

/** Runs the squash for every existing doc — acceptable at the "1-2 users" scale this system targets; see the compaction sweep for the pattern this mirrors. */
export async function runHistorySquashSweep(pool: Pool, createdBy: CreatedBy = "system", retentionMs = DEFAULT_HISTORY_RETENTION_MS): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM docs`);
  for (const row of rows) {
    await squashDocHistory(pool, row.id, createdBy, retentionMs);
  }
  return rows.length;
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
 * and deletes `doc_updates` rows, so any `at` at or after a doc's first-ever
 * checkpoint reconstructs correctly. The one window this can't recover is `at` falling
 * strictly between a doc's creation and its first-ever checkpoint, if that first
 * checkpoint's own compaction has already deleted the intervening updates by the time
 * this is called — there is no earlier checkpoint to fall back to, by definition. That
 * case is detected below (via `doc_snapshots.updated_at`, which a compaction always
 * advances past `at`) and raises `ValidationError` instead of silently returning a doc
 * missing content that genuinely existed at `at`.
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

    if (!checkpointRows[0]) {
      const { rows: snapshotRows } = await client.query<{ updated_at: Date }>(`SELECT updated_at FROM doc_snapshots WHERE doc_id = $1`, [docId]);
      if (snapshotRows[0] && snapshotRows[0].updated_at > at) {
        throw new ValidationError(
          `Cannot reconstruct doc ${docId} as of ${at.toISOString()}: no checkpoint covers that time, and a compaction since has already deleted the doc_updates that would`,
          { docId, at: at.toISOString() },
        );
      }
    }

    return doc;
  });
}
