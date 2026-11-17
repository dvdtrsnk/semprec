import * as Y from "yjs";
import type { Pool, PoolClient } from "pg";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { requireAffectedRows, runAfterCommit, withTransaction } from "../db/pool.js";
import type { CreatedBy, DocKind } from "../types.js";
import { notifyDocUpdate } from "../realtimeHook.js";
import { resolveDocHistoryRetentionDays, retentionHours } from "./docHistoryConfig.js";
import { logger } from "./logger.js";
import { assertSweepNotFailedEntirely, type SweepOutcome } from "./sweepOutcome.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import { enqueueSearchLaneJob } from "../search/searchLaneEnqueue.js";

/** y-leveldb uses 500, y-postgresql uses 200. */
export const DEFAULT_COMPACTION_THRESHOLD = 200;

/** Further edits within the window keep the first run time. */
const PAGE_TEXT_DEBOUNCE_MS = 30_000;

/** Measured from the first edit of a burst. */
const PAGE_TITLE_MIRROR_DEBOUNCE_MS = 10_000;

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
 * Store-then-delete, never the reverse. Must run in the same transaction as the read that produced `doc` and
 * `mergedUpdates`, so a concurrent update is simply not among the locked rows and converges by CRDT commutativity.
 *
 * Also writes a `doc_snapshot_history` checkpoint whose `through_update_id` is the inclusive boundary
 * `openDocVersionAt` resumes from. `doc_history_updates` is never touched by compaction.
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
    // Greatest id (rows are id-ordered): the boundary even when several updates share a timestamp.
    const boundary = mergedUpdates[mergedUpdates.length - 1]!;
    // A dormant doc's checkpoint may expire while still inside the retention window; reads then replay from the
    // earlier NULL-expiry baseline, so this never causes a false `history_not_retained`.
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
 * `gc = false`: default GC would discard deleted content that history reconstruction needs. Compacts lazily on read
 * when over the threshold. The `FOR UPDATE` locks on `doc_snapshots`/`doc_updates` are the per-document lock that
 * serializes appends, compaction and history re-baselining.
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
 * The bytes a realtime `doc_update` NOTIFY points to. `null` when compaction already merged the row (NOTIFY delivery
 * races the DELETE); the WS fan-out then falls back to `doc_snapshots`, never to "nothing to send".
 */
export async function getDocUpdateById(pool: Pool, docId: string, updateId: string): Promise<Buffer | null> {
  const { rows } = await pool.query<{ update: Buffer }>(
    `SELECT update FROM doc_updates WHERE id = $1 AND doc_id = $2`,
    [updateId, docId],
  );
  return rows[0]?.update ?? null;
}

/**
 * The NOTIFY runs after commit so a subscriber never sees a row the caller's transaction later rolls back. The
 * `doc_history_updates` mirror reuses `doc_updates.id`, which `openDocVersionAt` relies on to resume from a
 * checkpoint's `through_update_id`.
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
  // Uses the insert's own created_at so the docs row and the update agree on the last edit.
  const docResult = await client.query<{ item_id: string; kind: DocKind }>(
    `UPDATE docs SET last_edited_at = $2::timestamptz, last_edited_by = $3 WHERE id = $1 RETURNING item_id, kind`,
    [docId, created_at, createdBy],
  );
  requireAffectedRows(docResult, `docs row ${docId} for last-edited tracking`);
  const doc = docResult.rows[0]!;
  await client.query(
    `INSERT INTO doc_history_updates (update_id, doc_id, update, created_by, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz + make_interval(hours => $6::int))`,
    [id, docId, updateBuffer, createdBy, created_at, retentionHours(retentionDays)],
  );
  if (doc.kind === "page") {
    // Both jobs exist only if the edit commits; `preserve_run_at` collapses a burst of edits onto the first run time
    // (the default `replace` would push it back for as long as the user types).
    enqueueSearchLaneJob(
      client,
      CORE_TASK_NAMES.ITEM_SEARCH_PAGE_TEXT,
      { itemId: doc.item_id },
      {
        jobKey: doc.item_id,
        jobKeyMode: "preserve_run_at",
        runAt: new Date(Date.now() + PAGE_TEXT_DEBOUNCE_MS),
      },
    );
    await enqueueJob(
      client,
      CORE_TASK_NAMES.PAGE_TITLE_MIRROR,
      { itemId: doc.item_id },
      {
        jobKey: `page-title-mirror:${doc.item_id}`,
        jobKeyMode: "preserve_run_at",
        runAt: new Date(Date.now() + PAGE_TITLE_MIRROR_DEBOUNCE_MS),
      },
    );
  }
  runAfterCommit(client, () => notifyDocUpdate({ docId, updateId: id, createdBy }));
}

/**
 * Persists the diff `fn` makes as one `doc_updates` row attributed to `origin`; no change, no row. Runs on the
 * caller's client so document and structured-data writes commit atomically.
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
 * Compacts rarely opened documents, which lazy compaction on read never reaches. Per-doc failures are logged so one
 * cannot abort the sweep.
 */
export async function runCompactionSweep(
  pool: Pool,
  threshold = DEFAULT_COMPACTION_THRESHOLD,
  retentionDays = resolveDocHistoryRetentionDays(),
): Promise<SweepOutcome> {
  const { rows } = await pool.query<{ doc_id: string }>(
    `SELECT doc_id FROM doc_updates GROUP BY doc_id HAVING count(*) >= $1`,
    [threshold],
  );
  let succeeded = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await loadDoc(pool, row.doc_id, threshold, retentionDays);
      succeeded++;
    } catch (err) {
      failed++;
      logger.error({ err, docId: row.doc_id }, "Failed to compact doc");
    }
  }
  return { succeeded, failed };
}

export async function handleDocCompactionSweepTask(pool: Pool): Promise<void> {
  await forEachActiveTenant(pool, async () => {
    const outcome = await runCompactionSweep(pool);
    assertSweepNotFailedEntirely("docCompactionSweep", outcome);
  });
}
