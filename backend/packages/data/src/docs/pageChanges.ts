import * as Y from "yjs";
import type { Pool } from "pg";
import { getBlocksMap, getOrderArray } from "@semprec/block-model";
import { withTransaction } from "../db/pool.js";
import type { CreatedBy } from "../types.js";
import { ValidationError } from "../errors.js";
import { assertDocVersionReadable, readCheckpointHeadAtOrBefore, readCheckpointState } from "./docHistory.js";

export type PageChangeKind = "insert" | "update" | "delete";

/** One change a stored update made to the blocks of a page. */
export interface PageChange {
  /** When the update was stored (ISO 8601). */
  at: string;
  /** The blocks the change touched, in document order (a deleted block in the order it had before the update). */
  blockIds: string[];
  kind: PageChangeKind;
}

export interface ListPageChangesOptions {
  /** Only updates stored after this instant are reported. */
  since: Date;
  /** Only updates stored with this author are reported. */
  by: CreatedBy;
  /** The most entries returned, oldest first. */
  limit: number;
}

/** A block's content as one comparable string: every field of its map, a text with its inline attributes. */
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
  /** The block ids of the document order that exist, then any block missing from it. */
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

/** `ids` in the order of `order`; an id the order does not hold sorts last, by id. */
function inOrder(ids: string[], order: readonly string[]): string[] {
  const rank = (id: string): number => {
    const index = order.indexOf(id);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...ids].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** The changes between two snapshots of one page: inserted, updated and deleted blocks, in that order, one entry per kind present. */
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

/** The most history updates one request replays, silent ones included. */
export const PAGE_CHANGES_MAX_UPDATES = 5_000;
/** The most serialized bytes one request replays: the checkpoint state plus every replayed update. */
export const PAGE_CHANGES_MAX_BYTES = 16 * 1024 * 1024;
/** Rows whose sizes one metadata query reads. */
const METADATA_ROWS = 200;
/** The most update bytes one fetch reads; an update larger than this is never fetched, so no group exceeds it. */
const FETCH_BYTES = 4 * 1024 * 1024;

function historyWindowTooLarge(): ValidationError {
  return new ValidationError("The page history since this time is too large to list; use a later 'since'", {
    field: "since",
    reason: "history_window_too_large",
  });
}

/**
 * The block changes stored updates made to the page document `docId` since `since` (issue #1680), computed by
 * replaying its history: the nearest checkpoint at or before `since`, then the retained `doc_history_updates` strictly
 * in `update_id` order. An update stored at or before `since` (by `created_at`) is applied without being reported;
 * each later update with the requested author is reported from the difference of the block maps before and after it:
 * a new id is an `insert`, a removed id a `delete`, a block whose fields or text changed an `update`. Timestamps only
 * decide what is reported, not the replay order, so an update is applied after the updates stored before it, including
 * the ones it was written on top of. Changes of different updates are never merged; one update that does more than one of these yields one
 * entry per kind, with the same `at` and that kind's block ids. Only the update's author decides which are listed: a
 * block written by a user-confirmed proposal is stored with author `user` and so is not an `ai_agent` change. Moving a
 * block changes the order, not the block, and is not reported.
 *
 * The whole read is one `REPEATABLE READ` transaction that takes no lock: the checkpoint, the document row and every
 * history page come from one snapshot, so a retention sweep that commits meanwhile cannot remove rows the checkpoint
 * relies on. Work is bounded by a fixed budget of `PAGE_CHANGES_MAX_UPDATES` updates and `PAGE_CHANGES_MAX_BYTES`
 * serialized bytes (the checkpoint state counts; its size is read before the state is fetched). Sizes are read in
 * pages of at most `METADATA_ROWS` rows and update bytes are fetched in groups of at most `FETCH_BYTES`; one update
 * larger than `FETCH_BYTES` cannot be fetched at all and makes the window too large when the replay reaches it. The replay
 * stops after the group that fills `limit`, so the rest of the history is not read; a replay that
 * needs more than the budget before that is a `ValidationError` on `since` with reason `history_window_too_large`.
 * The byte budget bounds what is read, not the memory a decoded Yjs state takes.
 *
 * `since` in the future is a `ValidationError`, one before the retained history a `HistoryNotRetainedError`
 * (`history_not_retained`), an unknown doc a `NotFoundError`.
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
            // A row that does not fit the budget, or is larger than one fetch group, ends the group. Only when it is the
            // first row of the group does the replay need it now and refuse, before any of its bytes are read; after a
            // valid prefix the prefix is replayed first and may already fill `limit`.
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
