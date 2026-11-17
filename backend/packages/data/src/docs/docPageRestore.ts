// Restores a page to an earlier instant as a forward update; history is never rewritten. Authored `user`: an agent
// call is held for approval, and the approver's decision is the user's.
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
import { assertAgentPageAccess } from "./pageOwnerDatabase.js";
import type { DocRow } from "../types.js";

/** Shaped like the choke point's own destructive checks. */
export interface PageRestoreCheck {
  operation: "page.restoreVersion";
  input: { itemId: string; at: string };
  /** Its `write` access to the page's owner database is checked first. */
  agentProjectItemId?: string;
}

/** Unknown, trashed, foreign and non-page items answer the same not-found. */
async function requirePageDoc(client: PoolClient, itemId: string): Promise<DocRow> {
  const [item] = await getItemsByIds(client, [itemId]);
  const locked = item ? await lockItemById(client, item.databaseId, itemId) : null;
  const doc = locked && !locked.deletedAt ? await docsStore.getDocByItemId(client, itemId) : null;
  if (!doc || doc.kind !== "page") {
    throw new NotFoundError(`Page for item ${itemId} not found`, { resource: "page", itemId });
  }
  return doc;
}

/** The same `doc_snapshots` row lock as `loadDocWithClient` and `rebaselineDocHistory`; the item is locked first. */
async function lockDocument(client: PoolClient, docId: string): Promise<void> {
  await client.query(`SELECT 1 FROM doc_snapshots WHERE doc_id = $1 FOR UPDATE`, [docId]);
}

/**
 * Checks the restore's preconditions without replaying history or writing. The document lock is taken before the
 * last-edit values are read, so no edit can commit between this and a restore in the same transaction.
 */
export async function computePageRestoreProjection(
  client: PoolClient,
  check: PageRestoreCheck,
): Promise<DestructiveResourceProjection> {
  await assertAgentPageAccess(client, check.agentProjectItemId, check.input.itemId, "write");
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

/** The item is locked before the document, so a deletion cannot invalidate the restore while it waits. */
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

function blockSnapshot(block: Y.Map<unknown>): string {
  return canonicalizeJson(
    Object.fromEntries(Array.from(block.entries(), ([key, value]) => [key, snapshotValue(value)])),
  );
}

/** Yjs types `toDelta()` as `any`. */
type TextDelta = Array<{ insert?: unknown; attributes?: Record<string, unknown> }>;

function snapshotValue(value: unknown): unknown {
  if (value instanceof Y.Text) return { text: value.toDelta() as TextDelta };
  if (value instanceof Y.AbstractType) return value.toJSON();
  return value;
}

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

/** Never writes a block that is identical in both states. */
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
    // Integrate the empty map first so fields land on the live document, not a detached prelim map.
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
