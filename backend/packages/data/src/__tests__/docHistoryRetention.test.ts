import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createDocStore, type DocStore } from "../docs/docStore.js";
import { openDocVersionAt, rebaselineDocHistory } from "../docs/docHistory.js";
import { listBlocks as readBlocks } from "../docs/blocks.js";
import { setDocUpdateHook } from "../realtimeHook.js";

const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

let pool: Pool;
let chokePoint: ChokePoint;
let docStore: DocStore;

/** Postgres's own clock, so the retention math below does not depend on test/database skew. */
async function databaseNow(): Promise<Date> {
  const { rows } = await pool.query<{ now: Date }>(`SELECT transaction_timestamp() AS now`);
  return rows[0]!.now;
}

/**
 * Creates a doc with two appended updates (blocks b1 then b2, so b1's update_id is the lower
 * one) and returns the doc id and both update ids in id order.
 */
async function docWithTwoUpdates(): Promise<{ docId: string; firstId: string; secondId: string }> {
  const db = await chokePoint.createDatabase({ name: "Pages" });
  const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
  await docStore.putBlock(item.id, { id: "b1", flavour: "paragraph" }, "user");
  await docStore.putBlock(item.id, { id: "b2", flavour: "paragraph" }, "user");
  const doc = await docStore.getDoc(item.id);
  if (!doc) throw new Error("doc not created");

  const { rows } = await pool.query<{ update_id: string }>(
    `SELECT update_id FROM doc_history_updates WHERE doc_id = $1 ORDER BY update_id ASC`,
    [doc.id],
  );
  expect(rows).toHaveLength(2);
  return { docId: doc.id, firstId: rows[0]!.update_id, secondId: rows[1]!.update_id };
}

/** Moves the doc's availability and its initial baseline checkpoint back to `at`. */
async function backdateBaseline(docId: string, at: Date): Promise<void> {
  await pool.query(`UPDATE docs SET history_available_from = $2 WHERE id = $1`, [docId, at]);
  const { rowCount } = await pool.query(
    `UPDATE doc_snapshot_history SET represented_at = $2 WHERE doc_id = $1 AND through_update_id = 0`,
    [docId, at],
  );
  expect(rowCount).toBe(1);
}

/** Sets one append's `created_at` in both the live log and its history mirror. */
async function setUpdateCreatedAt(docId: string, updateId: string, at: Date): Promise<void> {
  const live = await pool.query(`UPDATE doc_updates SET created_at = $3 WHERE doc_id = $1 AND id = $2`, [
    docId,
    updateId,
    at,
  ]);
  const history = await pool.query(
    `UPDATE doc_history_updates SET created_at = $3 WHERE doc_id = $1 AND update_id = $2`,
    [docId, updateId, at],
  );
  expect(live.rowCount).toBe(1);
  expect(history.rowCount).toBe(1);
}

async function historyUpdateIds(docId: string): Promise<string[]> {
  const { rows } = await pool.query<{ update_id: string }>(
    `SELECT update_id FROM doc_history_updates WHERE doc_id = $1 ORDER BY update_id ASC`,
    [docId],
  );
  return rows.map((r) => r.update_id);
}

async function baselines(docId: string): Promise<{ through_update_id: string; expires_at: Date | null }[]> {
  const { rows } = await pool.query<{ through_update_id: string; expires_at: Date | null }>(
    `SELECT through_update_id, expires_at FROM doc_snapshot_history WHERE doc_id = $1`,
    [docId],
  );
  return rows;
}

async function blockIdsAt(docId: string, at: Date): Promise<string[]> {
  const version = await openDocVersionAt(pool, docId, at, RETENTION_DAYS);
  return readBlocks(version)
    .map((b) => String(b["sys:id"]))
    .sort();
}

describe("doc history retention rebaseline boundary", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint = createChokePoint(pool);
    docStore = createDocStore(pool);
    await resetDatabase(pool);
    setDocUpdateHook(() => {});
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("folds and deletes every update before the cutoff when they are contiguous by id", async () => {
    const reference = await databaseNow();
    const beforeCutoff = new Date(reference.getTime() - (RETENTION_DAYS + 10) * DAY_MS);
    const afterCutoff = new Date(reference.getTime() - (RETENTION_DAYS - 10) * DAY_MS);
    const { docId, firstId, secondId } = await docWithTwoUpdates();
    await backdateBaseline(docId, beforeCutoff);
    await setUpdateCreatedAt(docId, firstId, beforeCutoff);
    await setUpdateCreatedAt(docId, secondId, afterCutoff);

    expect(await rebaselineDocHistory(pool, docId, RETENTION_DAYS)).toBe(true);

    const checkpoints = await baselines(docId);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.through_update_id).toBe(firstId);
    expect(checkpoints[0]!.expires_at).toBeNull();
    expect(await historyUpdateIds(docId)).toEqual([secondId]);
    expect(await blockIdsAt(docId, await databaseNow())).toEqual(["b1", "b2"]);
  });

  it("never deletes an unfolded update when two appends straddle the cutoff with inverted id/timestamp order", async () => {
    const reference = await databaseNow();
    const beforeCutoff = new Date(reference.getTime() - (RETENTION_DAYS + 10) * DAY_MS);
    const earlyBaseline = new Date(reference.getTime() - (RETENTION_DAYS + 20) * DAY_MS);
    const afterCutoff = new Date(reference.getTime() - (RETENTION_DAYS - 10) * DAY_MS);
    // The lower id carries the later timestamp: the transaction that inserted second
    // started first.
    const { docId, firstId, secondId } = await docWithTwoUpdates();
    await backdateBaseline(docId, earlyBaseline);
    await setUpdateCreatedAt(docId, firstId, afterCutoff);
    await setUpdateCreatedAt(docId, secondId, beforeCutoff);

    expect(await rebaselineDocHistory(pool, docId, RETENTION_DAYS)).toBe(true);

    // Nothing lies before the gap, so the new baseline stays at the old checkpoint's boundary
    // and neither update is deleted — the one past the cutoff was never folded.
    const checkpoints = await baselines(docId);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.through_update_id).toBe("0");
    expect(checkpoints[0]!.expires_at).toBeNull();
    expect(await historyUpdateIds(docId)).toEqual([firstId, secondId]);

    expect(await blockIdsAt(docId, await databaseNow())).toEqual(["b1", "b2"]);
  });
});
