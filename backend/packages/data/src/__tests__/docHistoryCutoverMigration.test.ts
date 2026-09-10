import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createDocStore, type DocStore } from "../docs/docStore.js";
import { runDocHistoryCutoverMigration } from "../docs/docHistoryCutoverMigration.js";

let pool: Pool;
let chokePoint: ChokePoint;
let docStore: DocStore;

describe("runDocHistoryCutoverMigration", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint = createChokePoint(pool);
    docStore = createDocStore(pool);
    await resetDatabase(pool);
    // globalSetup already ran the cutover migration once for the whole test run, tightening
    // through_update_id/represented_at to NOT NULL. resetDatabase only truncates data, not
    // schema, so every test here must relax the columns back to reproduce the pre-cutover
    // (nullable) shape before seeding old-style rows and exercising the migration itself.
    await pool.query(`ALTER TABLE doc_snapshot_history ALTER COLUMN through_update_id DROP NOT NULL`);
    await pool.query(`ALTER TABLE doc_snapshot_history ALTER COLUMN represented_at DROP NOT NULL`);
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makeItem() {
    const db = await chokePoint.createDatabase({ name: "Pages" });
    const item = await chokePoint.createItem({ databaseId: db.id, properties: {} });
    return item;
  }

  it("removes every ambiguous pre-#216 checkpoint and installs exactly one valid cutover baseline per doc, reconstructing current state", async () => {
    // Doc A: several old-style checkpoints (no through_update_id boundary) plus surviving updates.
    const itemA = await makeItem();
    await docStore.putBlock(itemA.id, { id: "a1", flavour: "paragraph" }, "user");
    const docA = await docStore.getDoc(itemA.id);
    if (!docA) throw new Error("doc not created");
    await docStore.putBlock(itemA.id, { id: "a2", flavour: "paragraph" }, "user");

    // Doc A already got a NOT NULL baseline row from getOrCreateDoc/compaction under the
    // in-code schema; roll it back to the ambiguous pre-#216 shape this migration must fix:
    // multiple old squash-style checkpoints with no through_update_id/represented_at.
    await pool.query(`DELETE FROM doc_snapshot_history WHERE doc_id = $1`, [docA.id]);
    await pool.query(
      `INSERT INTO doc_snapshot_history (doc_id, state, expires_at, created_by) VALUES ($1, '\\x'::bytea, now() + interval '1 day', 'system')`,
      [docA.id],
    );
    await pool.query(
      `INSERT INTO doc_snapshot_history (doc_id, state, expires_at, created_by) VALUES ($1, '\\x'::bytea, now() + interval '2 days', 'system')`,
      [docA.id],
    );
    await pool.query(`UPDATE docs SET history_available_from = NULL WHERE id = $1`, [docA.id]);

    // Doc B: no history rows at all, just a snapshot and one update — the "never squashed" case.
    const itemB = await makeItem();
    await docStore.putBlock(itemB.id, { id: "b1", flavour: "paragraph" }, "user");
    const docB = await docStore.getDoc(itemB.id);
    if (!docB) throw new Error("doc not created");
    await pool.query(`DELETE FROM doc_snapshot_history WHERE doc_id = $1`, [docB.id]);
    await pool.query(`UPDATE docs SET history_available_from = NULL WHERE id = $1`, [docB.id]);

    const { rows: preUpdateRowsA } = await pool.query<{ id: string }>(
      `SELECT id FROM doc_updates WHERE doc_id = $1 ORDER BY id DESC LIMIT 1`,
      [docA.id],
    );
    const lastUpdateIdA = preUpdateRowsA[0]!.id;

    await runDocHistoryCutoverMigration(pool);

    for (const docId of [docA.id, docB.id]) {
      const { rows } = await pool.query<{
        through_update_id: string;
        represented_at: Date;
        expires_at: Date | null;
      }>(`SELECT through_update_id, represented_at, expires_at FROM doc_snapshot_history WHERE doc_id = $1`, [docId]);
      expect(rows).toHaveLength(1); // old ambiguous checkpoints are gone
      expect(rows[0]!.expires_at).toBeNull();
    }

    const { rows: checkpointA } = await pool.query<{ through_update_id: string }>(
      `SELECT through_update_id FROM doc_snapshot_history WHERE doc_id = $1`,
      [docA.id],
    );
    expect(checkpointA[0]!.through_update_id).toBe(lastUpdateIdA);

    const { rows: checkpointB } = await pool.query<{ through_update_id: string }>(
      `SELECT through_update_id FROM doc_snapshot_history WHERE doc_id = $1`,
      [docB.id],
    );
    expect(checkpointB[0]!.through_update_id).not.toBe("0"); // doc B's single update survived and is included

    const { rows: docRowsA } = await pool.query<{ history_available_from: Date | null }>(
      `SELECT history_available_from FROM docs WHERE id = $1`,
      [docA.id],
    );
    expect(docRowsA[0]!.history_available_from).not.toBeNull();

    const { rows: columnRows } = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'doc_snapshot_history' AND column_name IN ('through_update_id', 'represented_at')`,
    );
    expect(columnRows.every((r) => r.is_nullable === "NO")).toBe(true);

    // Current state reconstructs correctly from the cutover baseline alone.
    const blocksA = await docStore.listBlocks(itemA.id);
    expect(blocksA.map((b) => b["sys:id"]).sort()).toEqual(["a1", "a2"]);
    const blocksB = await docStore.listBlocks(itemB.id);
    expect(blocksB.map((b) => b["sys:id"])).toEqual(["b1"]);
  });

  it("is idempotent: running it again after constraints have tightened is a no-op", async () => {
    const item = await makeItem();
    await docStore.putBlock(item.id, { id: "x1", flavour: "paragraph" }, "user");

    await runDocHistoryCutoverMigration(pool);
    const { rows: before } = await pool.query(`SELECT * FROM doc_snapshot_history`);

    await runDocHistoryCutoverMigration(pool);
    const { rows: after } = await pool.query(`SELECT * FROM doc_snapshot_history`);

    expect(after).toEqual(before);
  });

  it("leaves a doc with no snapshot/updates alone with an empty-state baseline", async () => {
    // Reaching a truly doc-less item isn't possible through docStore (lazy creation), so this
    // exercises the loop's "no snapshot row" branch directly via getOrCreateDoc without content.
    const item = await makeItem();
    const client = await pool.connect();
    let docId: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO docs (item_id, kind) VALUES ($1, 'page') RETURNING id`,
        [item.id],
      );
      docId = rows[0]!.id;
    } finally {
      client.release();
    }

    await runDocHistoryCutoverMigration(pool);

    const { rows } = await pool.query<{ state: Buffer; through_update_id: string }>(
      `SELECT state, through_update_id FROM doc_snapshot_history WHERE doc_id = $1`,
      [docId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.through_update_id).toBe("0");
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, rows[0]!.state);
    expect(ydoc.getMap("blocks").size).toBe(0);
  });
});
