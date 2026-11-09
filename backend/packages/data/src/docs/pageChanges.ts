import * as Y from "yjs";
import type { Pool } from "pg";
import { getBlocksMap, getOrderArray } from "@semprec/block-model";
import { withTransaction } from "../db/pool.js";
import type { CreatedBy } from "../types.js";
import { assertDocVersionReadable, readCheckpointAtOrBefore } from "./docHistory.js";

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

/**
 * The block changes stored updates made to the page document `docId` since `since` (issue #1680), computed by
 * replaying its history: the nearest checkpoint at or before `since`, then the retained `doc_history_updates` in id
 * order, the ones stored by `since` silently and the later ones one by one. For each later update with the requested
 * author the block maps before and after it are compared: a new id is an `insert`, a removed id a `delete`, a block
 * whose fields or text changed an `update`. Changes of different updates are never merged; one update that does more
 * than one of these yields one entry per kind, with the same `at`. Only the update's author decides which are listed:
 * a block written by a user-confirmed proposal is stored with author `user` and so is not an `ai_agent` change.
 * Moving a block changes the order, not the block, and is not reported.
 *
 * `since` in the future is a `ValidationError`, one before the retained history a `HistoryNotRetainedError`
 * (`history_not_retained`), an unknown doc a `NotFoundError`; the whole read runs in one transaction.
 */
export async function listPageChanges(
  pool: Pool,
  docId: string,
  options: ListPageChangesOptions,
): Promise<PageChange[]> {
  return withTransaction(pool, async (client) => {
    await assertDocVersionReadable(client, docId, options.since);
    const checkpoint = await readCheckpointAtOrBefore(client, docId, options.since);
    const doc = new Y.Doc();
    doc.gc = false;
    try {
      Y.applyUpdate(doc, checkpoint.state);
      const { rows } = await client.query<{ update: Buffer; created_by: CreatedBy; created_at: Date }>(
        `SELECT update, created_by, created_at FROM doc_history_updates
         WHERE doc_id = $1 AND update_id > $2 ORDER BY update_id ASC`,
        [docId, checkpoint.throughUpdateId],
      );
      // The state at `since` first: every update stored by then, whoever wrote it.
      for (const row of rows) {
        if (row.created_at.getTime() <= options.since.getTime()) Y.applyUpdate(doc, row.update);
      }
      const changes: PageChange[] = [];
      for (const row of rows) {
        if (row.created_at.getTime() <= options.since.getTime()) continue;
        const before = row.created_by === options.by ? snapshotOf(doc) : undefined;
        Y.applyUpdate(doc, row.update);
        if (before === undefined) continue;
        changes.push(...diffSnapshots(before, snapshotOf(doc), row.created_at.toISOString()));
        if (changes.length >= options.limit) return changes.slice(0, options.limit);
      }
      return changes;
    } finally {
      doc.destroy();
    }
  });
}
