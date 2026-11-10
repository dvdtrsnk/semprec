// Restores a page document to the state it had at an earlier instant (issue #1617). The restore is
// a forward update on the live document: history is never rewritten, and the update is authored
// `user`, because the restore is an explicit user decision. An agent call is held for approval first,
// and the approver's decision is the user's.
// Constrained by: docs/adr/2026-10-28-page-operation-family.md, docs/adr/2026-10-28-block-model-for-page-documents.md
import * as Y from "yjs";
import type { PoolClient } from "pg";
import { getBlocksMap, getOrderArray, readPageBlocks } from "@semprec/block-model";
import { canonicalizeJson, type PageRestoreOutput } from "@semprec/shared";
import { getItemsByIds, lockItemById } from "../chokePoint/itemsStore.js";
import { buildResourceSnapshot, type DestructiveResourceProjection } from "../chokePoint/destructiveProjection.js";
import { NotFoundError } from "../errors.js";
import { resolveDocHistoryRetentionDays } from "./docHistoryConfig.js";
import { assertDocVersionReadable, openDocVersionAtWithClient } from "./docHistory.js";
import { DEFAULT_COMPACTION_THRESHOLD, mutateDocWithClient } from "./docPersistence.js";
import * as docsStore from "./docsStore.js";
import type { DocRow } from "../types.js";

/** The approval-gated check of `page.restoreVersion`, shaped like the choke point's own destructive checks (issue #1617). */
export interface PageRestoreCheck {
  operation: "page.restoreVersion";
  input: { itemId: string; at: string };
}

/**
 * The page document of a live item. An unknown or trashed item, an item of another tenant, and an
 * item whose document is not a `page` all answer the same not-found.
 */
async function requirePageDoc(client: PoolClient, itemId: string): Promise<DocRow> {
  const [item] = await getItemsByIds(client, [itemId]);
  const locked = item ? await lockItemById(client, item.databaseId, itemId) : null;
  const doc = locked && !locked.deletedAt ? await docsStore.getDocByItemId(client, itemId) : null;
  if (!doc || doc.kind !== "page") {
    throw new NotFoundError(`Page for item ${itemId} not found`, { resource: "page", itemId });
  }
  return doc;
}

/**
 * The document lock shared by document writes (`loadDocWithClient`, `rebaselineDocHistory`):
 * the `doc_snapshots` row, held until the caller's transaction ends. Restore locks the item first.
 */
async function lockDocument(client: PoolClient, docId: string): Promise<void> {
  await client.query(`SELECT 1 FROM doc_snapshots WHERE doc_id = $1 FOR UPDATE`, [docId]);
}

/**
 * The approval snapshot of a restore: the page's identity and its last recorded edit. It checks the
 * same preconditions the restore checks (a live page, a future or unretained `at`) without replaying
 * history, and it never writes. The document lock is taken before the last-edit values are read, so
 * an edit cannot commit between this read and a restore in the same transaction.
 */
export async function computePageRestoreProjection(
  client: PoolClient,
  check: PageRestoreCheck,
): Promise<DestructiveResourceProjection> {
  const { id: docId } = await requirePageDoc(client, check.input.itemId);
  await lockDocument(client, docId);
  const doc = await requirePageDoc(client, check.input.itemId);
  await assertDocVersionReadable(client, doc.id, new Date(check.input.at));
  const version = await client.query<{ version: string }>(
    `SELECT GREATEST(
       COALESCE((SELECT max(id) FROM doc_updates WHERE doc_id = $1 AND tenant_id = app_tenant_default()), 0),
       COALESCE((SELECT max(update_id) FROM doc_history_updates WHERE doc_id = $1 AND tenant_id = app_tenant_default()), 0),
       COALESCE((SELECT max(through_update_id) FROM doc_snapshot_history WHERE doc_id = $1 AND tenant_id = app_tenant_default()), 0)
     )::text AS version`,
    [doc.id],
  );
  const updateVersion = version.rows[0]?.version;
  if (updateVersion === undefined) throw new Error("Missing document update version");
  const projected = {
    docId: doc.id,
    itemId: doc.itemId,
    lastEditedAt: doc.lastEditedAt,
    lastEditedBy: doc.lastEditedBy,
    updateVersion,
  };
  return { snapshot: buildResourceSnapshot("page_restore", doc.id, projected), currentResource: projected };
}

/**
 * Restores the page of `itemId` to its state at `at`, inside the caller's transaction (issue #1617).
 * The live item is locked before the document, so deletion cannot invalidate the restore while it
 * waits. The historical read and the difference see the same document. The difference is applied
 * as one update authored `user`; a restore that changes nothing writes no update.
 */
export async function restorePageVersionWithClient(
  client: PoolClient,
  itemId: string,
  at: Date,
  retentionDays = resolveDocHistoryRetentionDays(),
): Promise<PageRestoreOutput> {
  const doc = await requirePageDoc(client, itemId);
  await lockDocument(client, doc.id);
  const historical = await openDocVersionAtWithClient(client, doc.id, at, retentionDays);
  const blockIds = await mutateDocWithClient(
    client,
    doc.id,
    "user",
    (live) => {
      applyPageRestore(live, historical);
      return readPageBlocks(live).flatMap((block) => (block.id === null ? [] : [block.id]));
    },
    DEFAULT_COMPACTION_THRESHOLD,
    retentionDays,
  );
  return { itemId, at: at.toISOString(), blockIds };
}

/** A block's content as canonical JSON, with each `Y.Text` read as its delta, so two equal blocks compare equal. */
function blockSnapshot(block: Y.Map<unknown>): string {
  return canonicalizeJson(
    Object.fromEntries(Array.from(block.entries(), ([key, value]) => [key, snapshotValue(value)])),
  );
}

/** A `Y.Text` delta as this model writes it: string inserts with optional inline attributes. Yjs types `toDelta()` as `any`. */
type TextDelta = Array<{ insert?: unknown; attributes?: Record<string, unknown> }>;

function snapshotValue(value: unknown): unknown {
  if (value instanceof Y.Text) return { text: value.toDelta() as TextDelta };
  if (value instanceof Y.AbstractType) return value.toJSON();
  return value;
}

/** Writes one field of a restored block. Block fields are scalars, `Y.Text` or plain JSON; a nested shared type is written as its JSON. */
function writeField(block: Y.Map<unknown>, key: string, value: unknown): void {
  if (value instanceof Y.Text) {
    const text = new Y.Text();
    block.set(key, text);
    text.applyDelta(value.toDelta() as TextDelta);
    return;
  }
  block.set(key, value instanceof Y.AbstractType ? value.toJSON() : value);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * The block-level difference between the live document and its historical state, applied to the live
 * document inside its `transact`. A block present now but not then is removed. A block present then
 * but absent or different now is written again from its historical copy (a reset). A block identical
 * in both is not written at all, so the restore never touches a block it does not change. Document
 * order is set to the historical order when it differs.
 */
export function applyPageRestore(live: Y.Doc, historical: Y.Doc): void {
  const liveBlocks = getBlocksMap(live);
  const historicalBlocks = getBlocksMap(historical);
  const ids = Array.from(new Set([...liveBlocks.keys(), ...historicalBlocks.keys()])).sort();
  for (const id of ids) {
    const historicalBlock = historicalBlocks.get(id);
    if (historicalBlock === undefined) {
      if (liveBlocks.has(id)) liveBlocks.delete(id);
      continue;
    }
    const liveBlock = liveBlocks.get(id);
    if (liveBlock !== undefined && blockSnapshot(liveBlock) === blockSnapshot(historicalBlock)) continue;
    // Integrate the empty block first and fill it afterwards, as `writeBlock` does: the fields
    // then land on the live document rather than on a detached prelim map.
    const restored = new Y.Map<unknown>();
    liveBlocks.set(id, restored);
    for (const [key, value] of historicalBlock.entries()) writeField(restored, key, value);
  }

  const liveOrder = getOrderArray(live);
  const wantedOrder = getOrderArray(historical).toArray();
  if (!sameIds(liveOrder.toArray(), wantedOrder)) {
    if (liveOrder.length > 0) liveOrder.delete(0, liveOrder.length);
    if (wantedOrder.length > 0) liveOrder.insert(0, wantedOrder);
  }
}
