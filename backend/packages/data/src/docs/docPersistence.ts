import * as Y from "yjs";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import type { CreatedBy } from "../types.js";
import { notifyDocUpdate } from "../realtimeHook.js";

/** y-leveldb uses 500, y-postgresql uses 200 — the issue asks for "the same shape", 200-500. */
export const DEFAULT_COMPACTION_THRESHOLD = 200;

interface PendingUpdateRow {
  id: string;
  update: Buffer;
}

async function loadSnapshotForUpdate(client: PoolClient, docId: string): Promise<Buffer | null> {
  const { rows } = await client.query<{ state: Buffer }>(`SELECT state FROM doc_snapshots WHERE doc_id = $1 FOR UPDATE`, [docId]);
  return rows[0]?.state ?? null;
}

async function loadPendingUpdatesForUpdate(client: PoolClient, docId: string): Promise<PendingUpdateRow[]> {
  const { rows } = await client.query<PendingUpdateRow>(
    `SELECT id, update FROM doc_updates WHERE doc_id = $1 ORDER BY id ASC FOR UPDATE`,
    [docId],
  );
  return rows;
}

/**
 * Compacts `doc_updates` into `doc_snapshots`: store the merged state first, only then
 * delete the merged rows (issue #23, point 5 — "store-then-delete, never the reverse").
 * Must run inside the same transaction as the read that produced `doc` and
 * `mergedUpdateIds`, so a concurrent update landing mid-compaction is simply not among
 * the rows locked/read/deleted here — commutativity of CRDT merging means it converges
 * correctly regardless of ordering.
 */
async function compact(client: PoolClient, docId: string, doc: Y.Doc, mergedUpdateIds: string[]): Promise<void> {
  const state = Buffer.from(Y.encodeStateAsUpdate(doc));
  const stateVector = Buffer.from(Y.encodeStateVector(doc));
  await client.query(
    `INSERT INTO doc_snapshots (doc_id, state, state_vector, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (doc_id) DO UPDATE SET state = EXCLUDED.state, state_vector = EXCLUDED.state_vector, updated_at = now()`,
    [docId, state, stateVector],
  );
  if (mergedUpdateIds.length > 0) {
    await client.query(`DELETE FROM doc_updates WHERE doc_id = $1 AND id = ANY($2::bigint[])`, [docId, mergedUpdateIds]);
  }
}

/**
 * Loads a headless `Y.Doc` (`gc = false` — see issue #23, point 4: default GC would
 * permanently discard deleted content, breaking `doc_snapshot_history`'s ability to
 * reconstruct it) by replaying `doc_snapshots` plus the following `doc_updates`.
 *
 * Compaction threshold is checked lazily here, on read (issue #23, point 5): if the
 * pending update count has crossed the threshold, the just-computed merged state is
 * written back and the merged rows deleted, in the same transaction as this read.
 */
export async function loadDoc(pool: Pool, docId: string, compactionThreshold = DEFAULT_COMPACTION_THRESHOLD): Promise<Y.Doc> {
  return withTransaction(pool, async (client) => {
    const snapshot = await loadSnapshotForUpdate(client, docId);
    const pendingUpdates = await loadPendingUpdatesForUpdate(client, docId);

    const doc = new Y.Doc();
    doc.gc = false;
    if (snapshot) Y.applyUpdate(doc, snapshot);
    for (const row of pendingUpdates) Y.applyUpdate(doc, row.update);

    if (pendingUpdates.length >= compactionThreshold) {
      await compact(
        client,
        docId,
        doc,
        pendingUpdates.map((row) => row.id),
      );
    }
    return doc;
  });
}

async function appendDocUpdate(pool: Pool, docId: string, update: Uint8Array, createdBy: CreatedBy): Promise<void> {
  const updateBuffer = Buffer.from(update);
  await withTransaction(pool, (client) => client.query(`INSERT INTO doc_updates (doc_id, update, created_by) VALUES ($1, $2, $3)`, [docId, updateBuffer, createdBy]));
  notifyDocUpdate({ docId, update: updateBuffer.toString("base64"), createdBy });
}

/**
 * Loads the doc, runs `fn` inside `doc.transact(fn, origin)`, and persists the
 * resulting binary diff as a new `doc_updates` row attributed to `origin` — the Yjs
 * `origin` parameter propagating into `created_by` (issue #23, point 4, steps 3-5).
 * `fn` returning without mutating the doc produces no `doc_updates` row.
 */
export async function mutateDoc<T>(pool: Pool, docId: string, origin: CreatedBy, fn: (doc: Y.Doc) => T, compactionThreshold = DEFAULT_COMPACTION_THRESHOLD): Promise<T> {
  const doc = await loadDoc(pool, docId, compactionThreshold);

  let capturedUpdate: Uint8Array | null = null;
  const onUpdate = (update: Uint8Array) => {
    capturedUpdate = update;
  };
  doc.on("update", onUpdate);
  let result: T;
  try {
    result = doc.transact(() => fn(doc), origin);
  } finally {
    doc.off("update", onUpdate);
  }

  if (capturedUpdate) {
    await appendDocUpdate(pool, docId, capturedUpdate, origin);
  }
  return result;
}

/** Periodic sweep (issue #23, point 5): catches up documents that are rarely opened, so their log doesn't grow unboundedly just because nobody reads them. */
export async function runCompactionSweep(pool: Pool, threshold = DEFAULT_COMPACTION_THRESHOLD): Promise<number> {
  const { rows } = await pool.query<{ doc_id: string }>(`SELECT doc_id FROM doc_updates GROUP BY doc_id HAVING count(*) >= $1`, [threshold]);
  for (const row of rows) {
    await loadDoc(pool, row.doc_id, threshold);
  }
  return rows.length;
}

export async function handleDocCompactionSweepTask(pool: Pool): Promise<void> {
  await runCompactionSweep(pool);
}
