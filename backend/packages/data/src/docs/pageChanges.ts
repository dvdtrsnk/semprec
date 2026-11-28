import * as Y from "yjs";
import type { Pool } from "pg";
import { getBlocksMap, getOrderArray } from "@alldots/block-model";
import { withTransaction } from "../db/pool.js";
import type { CreatedBy } from "../types.js";
import { ValidationError } from "../errors.js";
import { assertDocVersionReadable, readCheckpointHeadAtOrBefore, readCheckpointState } from "./docHistory.js";

export type PageChangeKind = "insert" | "update" | "delete";

export interface PageChange {
  at: string;
  /** Document order; deleted blocks in their order before the update. */
  blockIds: string[];
  kind: PageChangeKind;
}

export interface ListPageChangesOptions {
  since: Date;
  by: CreatedBy;
  limit: number;
}

function blockSignature(block: Y.Map<unknown>): string {
  const entries = [...block.keys()].sort().map((key): [string, unknown] => {
    const value = block.get(key);
    if (value instanceof Y.Text) return [key, value.toDelta()];
    if (value instanceof Y.AbstractType) return [key, value.toJSON()];
    return [key, value];
  });
  return JSON.stringify(entries);
}

interface BlockSnapshot {
  signatures: Map<string, string>;
  /** Document order, then blocks missing from it. */
  order: string[];
}

function snapshotOf(doc: Y.Doc): BlockSnapshot {
  const signatures = new Map<string, string>();
  getBlocksMap(doc).forEach((block, id) => {
    if (block instanceof Y.Map) signatures.set(id, blockSignature(block));
  });
  const order = getOrderArray(doc)
    .toArray()
    .filter((id, index, ids) => signatures.has(id) && ids.indexOf(id) === index);
  const missing = [...signatures.keys()].filter((id) => !order.includes(id)).sort();
  return { signatures, order: [...order, ...missing] };
}

function inOrder(ids: string[], order: readonly string[]): string[] {
  const rank = (id: string): number => {
    const index = order.indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...ids].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** One entry per kind present: insert, update, delete. */
function diffSnapshots(before: BlockSnapshot, after: BlockSnapshot, at: string): PageChange[] {
  const inserted = [...after.signatures.keys()].filter((id) => !before.signatures.has(id));
  const deleted = [...before.signatures.keys()].filter((id) => !after.signatures.has(id));
  const updated = [...after.signatures.entries()]
    .filter(([id, signature]) => before.signatures.has(id) && before.signatures.get(id) !== signature)
    .map(([id]) => id);
  const changes: PageChange[] = [];
  if (inserted.length > 0) changes.push({ at, blockIds: inOrder(inserted, after.order), kind: "insert" });
  if (updated.length > 0) changes.push({ at, blockIds: inOrder(updated, after.order), kind: "update" });
  if (deleted.length > 0) changes.push({ at, blockIds: inOrder(deleted, before.order), kind: "delete" });
  return changes;
}

/** Replayed updates per request, unreported ones included. */
export const PAGE_CHANGES_MAX_UPDATES = 5_000;
/** Checkpoint state plus every replayed update. */
export const PAGE_CHANGES_MAX_BYTES = 16 * 1024 * 1024;
const METADATA_ROWS = 200;
/** An update larger than this is never fetched. */
const FETCH_BYTES = 4 * 1024 * 1024;

function historyWindowTooLarge(): ValidationError {
  return new ValidationError("The page history since this time is too large to list; use a later 'since'", {
    field: "since",
    reason: "history_window_too_large",
  });
}

/**
 * Replays history from the checkpoint at or before `since` in `update_id` order (timestamps decide only what is
 * reported, not replay order) and diffs the block maps around each reported update. Only the stored author counts: a
 * user-confirmed agent proposal is stored as `user`. Moves change order only and are not reported.
 *
 * One lock-free REPEATABLE READ snapshot, so a concurrent retention sweep cannot remove rows the checkpoint relies on.
 * Work is bounded by `PAGE_CHANGES_MAX_UPDATES` and `PAGE_CHANGES_MAX_BYTES` (checkpoint size read before its state);
 * exceeding the budget before `limit` is filled is `history_window_too_large`. The byte budget bounds what is read,
 * not decoded Yjs memory.
 */
export async function listPageChanges(
  pool: Pool,
  docId: string,
  options: ListPageChangesOptions,
): Promise<PageChange[]> {
  return withTransaction(
    pool,
    async (client) => {
      await assertDocVersionReadable(client, docId, options.since);
      const head = await readCheckpointHeadAtOrBefore(client, docId, options.since);
      if (head.stateBytes > PAGE_CHANGES_MAX_BYTES) throw historyWindowTooLarge();
      let usedUpdates = 0;
      let usedBytes = head.stateBytes;
      const doc = new Y.Doc();
      doc.gc = false;
      try {
        Y.applyUpdate(doc, await readCheckpointState(client, head.id));
        const changes: PageChange[] = [];
        let cursor = head.throughUpdateId;
        for (;;) {
          const { rows: sizes } = await client.query<{ update_id: string; size: number }>(
            `SELECT update_id, octet_length(update)::int AS size FROM doc_history_updates
             WHERE doc_id = $1 AND update_id > $2 ORDER BY update_id ASC LIMIT $3`,
            [docId, cursor, METADATA_ROWS],
          );
          if (sizes.length === 0) return changes;
          const ids: string[] = [];
          let groupBytes = 0;
          for (const row of sizes) {
            // A non-fitting row ends the group; refuse only if it is first; a replayed prefix may already fill `limit`.
            const selectable =
              usedUpdates + ids.length < PAGE_CHANGES_MAX_UPDATES &&
              usedBytes + groupBytes + row.size <= PAGE_CHANGES_MAX_BYTES &&
              row.size <= FETCH_BYTES;
            if (!selectable) {
              if (ids.length === 0) throw historyWindowTooLarge();
              break;
            }
            if (groupBytes + row.size > FETCH_BYTES) break;
            ids.push(row.update_id);
            groupBytes += row.size;
          }
          const { rows } = await client.query<{
            update_id: string;
            update: Buffer;
            created_by: CreatedBy;
            created_at: Date;
          }>(
            `SELECT update_id, update, created_by, created_at FROM doc_history_updates
             WHERE doc_id = $1 AND update_id = ANY($2::bigint[]) ORDER BY update_id ASC`,
            [docId, ids],
          );
          if (rows.length !== ids.length) throw new Error("History rows disappeared inside their own snapshot");
          usedUpdates += rows.length;
          usedBytes += groupBytes;
          for (const row of rows) {
            const reported = row.created_at.getTime() > options.since.getTime() && row.created_by === options.by;
            const before = reported ? snapshotOf(doc) : undefined;
            Y.applyUpdate(doc, row.update);
            cursor = row.update_id;
            if (before === undefined) continue;
            changes.push(...diffSnapshots(before, snapshotOf(doc), row.created_at.toISOString()));
            if (changes.length >= options.limit) return changes.slice(0, options.limit);
          }
        }
      } finally {
        doc.destroy();
      }
    },
    { isolation: "repeatable_read" },
  );
}
