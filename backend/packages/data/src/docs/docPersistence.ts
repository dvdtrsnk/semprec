import * as Y from "yjs";
import type { Pool, PoolClient } from "pg";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import type { CreatedBy } from "../types.js";
import { notifyDocUpdate } from "../realtimeHook.js";
import { resolveDocHistoryRetentionDays, retentionHours } from "./docHistoryConfig.js";

/** y-leveldb uses 500, y-postgresql uses 200 — the issue asks for "the same shape", 200-500. */
export const DEFAULT_COMPACTION_THRESHOLD = 200;

interface PendingUpdateRow {
  id: string;
  update: Buffer;
  created_at: Date;
}

async function loadSnapshotForUpdate(client: PoolClient, docId: string): Promise<Buffer | null> {
  const { rows } = await client.query<{ state: Buffer }>(
    `SELECT state FROM doc_snapshots WHERE doc_id = $1 FOR UPDATE`,
    [docId],
  );
  return rows[0]?.state ?? null;
}

async function loadPendingUpdatesForUpdate(client: PoolClient, docId: string): Promise<PendingUpdateRow[]> {
  const { rows } = await client.query<PendingUpdateRow>(
    `SELECT id, update, created_at FROM doc_updates WHERE doc_id = $1 ORDER BY id ASC FOR UPDATE`,
    [docId],
  );
  return rows;
}

/**
 * Compacts `doc_updates` into `doc_snapshots`: store the merged state first, only then
 * delete the merged rows (issue #23, point 5 — "store-then-delete, never the reverse").
 * Must run inside the same transaction as the read that produced `doc` and
 * `mergedUpdates`, so a concurrent update landing mid-compaction is simply not among
 * the rows locked/read/deleted here — commutativity of CRDT merging means it converges
 * correctly regardless of ordering.
 *
 * Also drops a `doc_snapshot_history` checkpoint in the same transaction, under the same
 * document lock (issue #216): `through_update_id`/`represented_at` are the greatest merged
 * update's id/`created_at` — the inclusive boundary `openDocVersionAt` resumes replay from
 * using `doc_history_updates` (never touched here, and never deleted by compaction — that's
 * the whole point of mirroring appends into it). The mirrored log means this checkpoint is
 * no longer the only thing standing between a query and a `ValidationError`: even a doc
 * compacted many times over can always be reconstructed by replaying forward from its
 * nearest checkpoint through `doc_history_updates`.
 */
async function compact(
  client: PoolClient,
  docId: string,
  doc: Y.Doc,
  mergedUpdates: PendingUpdateRow[],
  retentionDays: number,
): Promise<void> {
  const state = Buffer.from(Y.encodeStateAsUpdate(doc));
  const stateVector = Buffer.from(Y.encodeStateVector(doc));
  await client.query(
    `INSERT INTO doc_snapshots (doc_id, state, state_vector, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (doc_id) DO UPDATE SET state = EXCLUDED.state, state_vector = EXCLUDED.state_vector, updated_at = now()`,
    [docId, state, stateVector],
  );

  if (mergedUpdates.length > 0) {
    // Rows are loaded ordered by id ascending, so the last one is the greatest id — the
    // inclusive boundary when several merged updates share a timestamp.
    const boundary = mergedUpdates[mergedUpdates.length - 1]!;
    await client.query(
      `INSERT INTO doc_snapshot_history (doc_id, state, through_update_id, represented_at, expires_at, created_by)
       VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz + make_interval(hours => $5::int), 'system')`,
      [docId, state, boundary.id, boundary.created_at, retentionHours(retentionDays)],
    );
    await client.query(`DELETE FROM doc_updates WHERE doc_id = $1 AND id = ANY($2::bigint[])`, [
      docId,
      mergedUpdates.map((row) => row.id),
    ]);
  }
}

/**
 * Loads a headless `Y.Doc` (`gc = false` — see issue #23, point 4: default GC would
 * permanently discard deleted content, breaking `doc_snapshot_history`'s ability to
 * reconstruct it) by replaying `doc_snapshots` plus the following `doc_updates`, inside
 * a caller-supplied transaction/client.
 *
 * Compaction threshold is checked lazily here, on read (issue #23, point 5): if the
 * pending update count has crossed the threshold, the just-computed merged state is
 * written back and the merged rows deleted, in the same transaction as this read.
 *
 * Exported (not just `loadDoc` below) so callers that already hold a transaction/client
 * (e.g. `docsStore.getOrCreateDoc`) can run this read in the same transaction as their own
 * writes — the `FOR UPDATE` locks taken here on `doc_snapshots`/`doc_updates` serialize
 * against a concurrent `compact()` on the same doc.
 */
export async function loadDocWithClient(
  client: PoolClient,
  docId: string,
  compactionThreshold = DEFAULT_COMPACTION_THRESHOLD,
  retentionDays = resolveDocHistoryRetentionDays(),
): Promise<Y.Doc> {
  const snapshot = await loadSnapshotForUpdate(client, docId);
  const pendingUpdates = await loadPendingUpdatesForUpdate(client, docId);

  const doc = new Y.Doc();
  doc.gc = false;
  if (snapshot) Y.applyUpdate(doc, snapshot);
  for (const row of pendingUpdates) Y.applyUpdate(doc, row.update);

  if (pendingUpdates.length >= compactionThreshold) {
    await compact(client, docId, doc, pendingUpdates, retentionDays);
  }
  return doc;
}

export async function loadDoc(
  pool: Pool,
  docId: string,
  compactionThreshold = DEFAULT_COMPACTION_THRESHOLD,
  retentionDays = resolveDocHistoryRetentionDays(),
): Promise<Y.Doc> {
  return withTransaction(pool, (client) => loadDocWithClient(client, docId, compactionThreshold, retentionDays));
}

/**
 * The realtime notification is deferred via `runAfterCommit` rather than fired here —
 * this runs inside the caller's still-open transaction (possibly one also writing other
 * tables, e.g. `inbox/proposalActions.ts`'s `confirmProposalWithClient`), and firing
 * immediately would let a subscriber observe a `doc_updates` row that a later failure in
 * that same transaction then rolls back.
 *
 * Mirrors the appended row into `doc_history_updates` in the same transaction, with the
 * same id/bytes/attribution/timestamp (issue #216): `doc_updates.id` is returned from the
 * INSERT via `RETURNING` rather than regenerated, so the mirrored row's `update_id` always
 * matches `doc_updates.id` exactly, which is what lets `openDocVersionAt` resume replay from
 * a checkpoint's `through_update_id` boundary.
 */
async function appendDocUpdateWithClient(
  client: PoolClient,
  docId: string,
  update: Uint8Array,
  createdBy: CreatedBy,
  retentionDays: number,
): Promise<void> {
  const updateBuffer = Buffer.from(update);
  const { rows } = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO doc_updates (doc_id, update, created_by) VALUES ($1, $2, $3) RETURNING id, created_at`,
    [docId, updateBuffer, createdBy],
  );
  const { id, created_at } = rows[0]!;
  await client.query(
    `INSERT INTO doc_history_updates (update_id, doc_id, update, created_by, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + make_interval(hours => $6::int))`,
    [id, docId, updateBuffer, createdBy, created_at, retentionHours(retentionDays)],
  );
  runAfterCommit(client, () => notifyDocUpdate({ docId, update: updateBuffer.toString("base64"), createdBy }));
}

/**
 * Loads the doc, runs `fn` inside `doc.transact(fn, origin)`, and persists the
 * resulting binary diff as a new `doc_updates` row attributed to `origin` — the Yjs
 * `origin` parameter propagating into `created_by` (issue #23, point 4, steps 3-5).
 * `fn` returning without mutating the doc produces no `doc_updates` row.
 *
 * Runs inside a caller-supplied transaction/client — so a caller that also writes to
 * the structured-data tables in the same transaction (e.g. inbox/proposalActions.ts's
 * `confirmProposalWithClient`, issue #105) gets one atomic commit across both, despite
 * docs being an otherwise-independent persistence mechanism (see docStore.ts's module
 * comment). `mutateDoc` below is the pool-opening convenience wrapper for callers with
 * no transaction of their own.
 */
export async function mutateDocWithClient<T>(
  client: PoolClient,
  docId: string,
  origin: CreatedBy,
  fn: (doc: Y.Doc) => T,
  compactionThreshold = DEFAULT_COMPACTION_THRESHOLD,
  retentionDays = resolveDocHistoryRetentionDays(),
): Promise<T> {
  const doc = await loadDocWithClient(client, docId, compactionThreshold, retentionDays);

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
    await appendDocUpdateWithClient(client, docId, capturedUpdate, origin, retentionDays);
  }
  return result;
}

export async function mutateDoc<T>(
  pool: Pool,
  docId: string,
  origin: CreatedBy,
  fn: (doc: Y.Doc) => T,
  compactionThreshold = DEFAULT_COMPACTION_THRESHOLD,
  retentionDays = resolveDocHistoryRetentionDays(),
): Promise<T> {
  return withTransaction(pool, (client) =>
    mutateDocWithClient(client, docId, origin, fn, compactionThreshold, retentionDays),
  );
}

/**
 * Periodic sweep (issue #23, point 5): catches up documents that are rarely opened, so
 * their log doesn't grow unboundedly just because nobody reads them. One doc failing
 * (a transient DB error, a corrupted update row) must not abort the sweep before it
 * reaches the rest of the over-threshold docs, so each is isolated and logged.
 */
export async function runCompactionSweep(
  pool: Pool,
  threshold = DEFAULT_COMPACTION_THRESHOLD,
  retentionDays = resolveDocHistoryRetentionDays(),
): Promise<number> {
  const { rows } = await pool.query<{ doc_id: string }>(
    `SELECT doc_id FROM doc_updates GROUP BY doc_id HAVING count(*) >= $1`,
    [threshold],
  );
  let succeeded = 0;
  for (const row of rows) {
    try {
      await loadDoc(pool, row.doc_id, threshold, retentionDays);
      succeeded++;
    } catch (err) {
      console.error(`Failed to compact doc ${row.doc_id}`, err);
    }
  }
  return succeeded;
}

export async function handleDocCompactionSweepTask(pool: Pool): Promise<void> {
  await runCompactionSweep(pool);
}
