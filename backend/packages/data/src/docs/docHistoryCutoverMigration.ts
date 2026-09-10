import * as Y from "yjs";
import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";

/**
 * One-time populated-upgrade cutover for issue #216's retained history model
 * (0036_doc_history_retention.sql adds the checkpoint-boundary columns nullable; this
 * finishes the job). Unlike every other migration in db/migrations/, this step cannot be
 * plain SQL: computing each doc's "full current-state cutover baseline... from
 * doc_snapshots plus surviving doc_updates" means merging Yjs binary updates, which only the
 * `yjs` library can do. So it runs as application code, invoked once (idempotently, guarded
 * below) immediately after `runMigrations` — see runMigrationsCli.ts and
 * testSupport/globalSetup.ts.
 *
 * Destructive only for the already-unusable pre-#216 `doc_snapshot_history` rows: they carry
 * no `through_update_id` boundary, so `openDocVersionAt`'s new selection contract could never
 * safely resume replay from them, and pre-cutover timestamps already contractually return
 * 410 `history_not_retained` regardless. `doc_updates`, `doc_snapshots`, and `docs`'s
 * pre-existing columns are untouched.
 *
 * Runs the whole cutover — lock, delete, per-doc reconstruct, insert, tighten constraints —
 * in one transaction, so a concurrent reader never observes a doc with old checkpoints
 * deleted but no new baseline installed yet.
 */
export async function runDocHistoryCutoverMigration(pool: Pool): Promise<void> {
  await withTransaction(pool, async (client) => {
    // Excludes any concurrent doc creation/write for the duration of the cutover, so no doc
    // can be left with its old checkpoints deleted and no baseline yet, or a baseline
    // installed from a state that a concurrent write then invalidates.
    await client.query(`LOCK TABLE docs IN EXCLUSIVE MODE`);

    // The idempotency check must run inside this transaction, after the lock is held: two
    // replicas invoking this concurrently at deploy time would otherwise both read
    // is_nullable='YES' before either takes the lock, and the second (now serialized behind
    // the first's commit) would re-delete and reinstall every baseline the first just wrote —
    // a transient window where concurrent readers see doc_snapshot_history empty.
    const { rows: columnRows } = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'doc_snapshot_history'
         AND column_name = 'through_update_id'`,
    );
    if (columnRows[0]?.is_nullable === "NO") return; // already migrated

    await client.query(`DELETE FROM doc_snapshot_history`);

    const { rows: cutoverRows } = await client.query<{ cutover_at: Date }>(
      `SELECT transaction_timestamp() AS cutover_at`,
    );
    const cutoverAt = cutoverRows[0]!.cutover_at;

    const { rows: docs } = await client.query<{ id: string }>(`SELECT id FROM docs`);
    for (const doc of docs) {
      const { rows: snapshotRows } = await client.query<{ state: Buffer }>(
        `SELECT state FROM doc_snapshots WHERE doc_id = $1`,
        [doc.id],
      );
      const { rows: updateRows } = await client.query<{ id: string; update: Buffer }>(
        `SELECT id, update FROM doc_updates WHERE doc_id = $1 ORDER BY id ASC`,
        [doc.id],
      );

      const ydoc = new Y.Doc();
      ydoc.gc = false;
      if (snapshotRows[0]) Y.applyUpdate(ydoc, snapshotRows[0].state);
      for (const row of updateRows) Y.applyUpdate(ydoc, row.update);
      const state = Buffer.from(Y.encodeStateAsUpdate(ydoc));

      const throughUpdateId = updateRows.length > 0 ? updateRows[updateRows.length - 1]!.id : "0";

      await client.query(
        `INSERT INTO doc_snapshot_history (doc_id, state, through_update_id, represented_at, expires_at, created_by)
         VALUES ($1, $2, $3, $4, NULL, 'system')`,
        [doc.id, state, throughUpdateId, cutoverAt],
      );
      await client.query(`UPDATE docs SET history_available_from = $2 WHERE id = $1`, [doc.id, cutoverAt]);
    }

    await client.query(`ALTER TABLE doc_snapshot_history ALTER COLUMN through_update_id SET NOT NULL`);
    await client.query(`ALTER TABLE doc_snapshot_history ALTER COLUMN represented_at SET NOT NULL`);
  });
}
