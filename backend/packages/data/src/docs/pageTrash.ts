// Trash and restore of subpages (issues #1723 and #1763): the choke point's delete and restore hooks for Pages items
// and for the items that host pages, and the walk over the live pages below an item. A trashed page takes its live
// subpages with it and leaves its parent's document; a restored page brings back the subpages trashed with it and its
// block. A trashed item of any other database takes its live subpages with it, and its restore brings them back.
// Constrained by: docs/adr/2026-11-10-trashed-pages-leave-the-parent-document-and-record-their-position.md,
// docs/adr/2026-11-12-a-trashed-host-takes-its-subpages-into-its-deletion-epoch.md,
// docs/adr/2026-10-29-subpages-are-items-of-a-hidden-pages-database.md,
// docs/adr/2026-11-07-item-delete-and-restore-domain-hooks.md,
// docs/adr/2026-11-08-restore-hooks-carry-exact-deletion-epochs.md
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type * as Y from "yjs";
import { z } from "zod";
import { MAX_INDENT, MIN_INDENT, deleteBlocks, getBlocksMap, insertBlocks, readPageBlocks } from "@semprec/block-model";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import type { ItemDeleteHook, ItemRestoreHook } from "../chokePoint/hooks.js";
import { lockItemTrashEpoch } from "../chokePoint/itemsStore.js";
import { itemDeleteWithClient, restoreItemWithClient } from "../chokePoint/itemTrash.js";
import type { WriterIdentity, WriterKind } from "../chokePoint/writerKind.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import type { CreatedBy, ItemRow } from "../types.js";
import { mutateDocWithClient } from "./docPersistence.js";
import { getDocByItemId } from "./docsStore.js";
import { PAGES_MODULE_ID } from "./pagesDatabase.js";

/** The top-level `Y.Map` of a page document that records, per trashed subpage id, where its `page` block stood. */
const TRASHED_PAGES_MAP_NAME = "trashedPages";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The author a document write of a hook is stored under, by who trashed or restored the page. */
const ORIGIN_BY_WRITER_KIND: Readonly<Record<WriterKind, CreatedBy>> = {
  user: "user",
  agent: "ai_agent",
  system: "system",
};

/**
 * One `trashedPages` entry: the id of the removed `page` block, the id of the block that stood before it (`null` when
 * it was the first block) and its indent. The map lives in a synced document, so an entry is parsed before it is used.
 */
const trashedPagePositionSchema = z.object({
  blockId: z.string().min(1),
  afterBlockId: z.string().nullable(),
  indent: z.number().int().min(MIN_INDENT).max(MAX_INDENT),
});

export type TrashedPagePosition = z.infer<typeof trashedPagePositionSchema>;

/**
 * The position `pageItemDeleteHook` recorded in `trashedPages` for the trashed page `pageId`, or `null` when `doc` has
 * no valid entry for it. The entry is left in place, so a restore of the page still finds its place.
 */
export function readTrashedPagePosition(doc: Y.Doc, pageId: string): TrashedPagePosition | null {
  const parsed = trashedPagePositionSchema.safeParse(doc.getMap<unknown>(TRASHED_PAGES_MAP_NAME).get(pageId));
  return parsed.success ? parsed.data : null;
}

/** The stored blocks of `doc` in document order, without the synthetic block an empty document is read as. */
function storedBlocks(doc: Y.Doc) {
  return readPageBlocks(doc).flatMap((block) => (block.id === null ? [] : [{ ...block, id: block.id }]));
}

/**
 * The ids of the live Pages items whose `parentItemId` is one of `parentItemIds`, in id order. A read without row
 * locks, for the walk of `collectSubpageTree`; the delete hooks select their subpages with `lockLiveChildPageIds`.
 */
async function listLiveChildPageIds(
  client: PoolClient,
  pagesDatabaseId: string,
  parentItemIds: readonly string[],
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
      WHERE database_id = $1 AND deleted_at IS NULL AND properties->>'parentItemId' = ANY($2::text[])
      ORDER BY id`,
    [pagesDatabaseId, parentItemIds],
  );
  return rows.map((row) => row.id);
}

/**
 * The ids of the live Pages items that name `parentItemId` as their parent, in id order. The same statement locks them
 * `FOR UPDATE`, so the trash of a page or of a host holds the row of every live subpage before it trashes the first of
 * them. A subpage whose own trash committed while this statement waited for its row is no longer live and is left out.
 * `replacePageMarkdown` (#1765) takes the same locks before it loads the host's document, for the same reason.
 */
export async function lockLiveChildPageIds(
  client: PoolClient,
  pagesDatabaseId: string,
  parentItemId: string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
      WHERE database_id = $1 AND properties->>'parentItemId' = $2 AND deleted_at IS NULL
      ORDER BY id
      FOR UPDATE`,
    [pagesDatabaseId, parentItemId],
  );
  return rows.map((row) => row.id);
}

/**
 * The ids of the Pages items that name `parentItemId` as their parent and are in the Trash with exactly the deletion
 * epoch `deletedAtExact`, in id order. The same statement locks them `FOR UPDATE`, so the epoch a row is matched on is
 * the one it still has when the caller restores it.
 */
async function lockChildPageIdsOfEpoch(
  client: PoolClient,
  pagesDatabaseId: string,
  parentItemId: string,
  deletedAtExact: string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM items
      WHERE database_id = $1 AND properties->>'parentItemId' = $2 AND deleted_at = $3::timestamptz
      ORDER BY id
      FOR UPDATE`,
    [pagesDatabaseId, parentItemId, deletedAtExact],
  );
  return rows.map((row) => row.id);
}

/**
 * The ids of the live Pages items below `rootItemId` (a host item or a page) at any depth, breadth first, each level
 * in id order; the root itself is not included, so the length is the number of nested pages. The walk follows
 * `parentItemId` through live pages only: a live page below a trashed one is not reached. Below a page these are the
 * pages its trash takes with it. An id is visited once, so a stored `parentItemId` cycle ends the walk. A tenant
 * without a Pages database has no pages.
 */
export async function collectSubpageTree(client: PoolClient, rootItemId: string): Promise<string[]> {
  const pagesDatabase = await getDatabaseByModuleId(client, PAGES_MODULE_ID);
  if (!pagesDatabase) return [];
  const visited = new Set([rootItemId]);
  const tree: string[] = [];
  let frontier = [rootItemId];
  while (frontier.length > 0) {
    const level = (await listLiveChildPageIds(client, pagesDatabase.id, frontier)).filter((id) => !visited.has(id));
    for (const id of level) visited.add(id);
    tree.push(...level);
    frontier = level;
  }
  return tree;
}

/** The id of the page document of the item `page` names as its parent, or `null` when there is none to edit. */
async function parentPageDocId(client: PoolClient, page: ItemRow): Promise<string | null> {
  const parentItemId: unknown = page.properties.parentItemId;
  if (typeof parentItemId !== "string" || !UUID_RE.test(parentItemId)) return null;
  const doc = await getDocByItemId(client, parentItemId);
  return doc?.kind === "page" ? doc.id : null;
}

/** The writer of a nested trash or restore of a subpage: the writer kind and agent run of the hook's own context. */
function writerOf(context: { writerKind: WriterKind; agentRunId?: string }): WriterIdentity {
  return {
    writerKind: context.writerKind,
    ...(context.agentRunId === undefined ? {} : { agentRunId: context.agentRunId }),
  };
}

/**
 * Removes the first block of `doc` whose `pageId` is `pageId` and records its position in `trashedPages`. A document
 * without such a block is left as it is.
 */
function removePageBlock(doc: Y.Doc, pageId: string): void {
  const blocks = storedBlocks(doc);
  const index = blocks.findIndex((block) => block.pageId === pageId);
  const block = blocks[index];
  if (block === undefined) return;
  const position: TrashedPagePosition = {
    blockId: block.id,
    afterBlockId: blocks[index - 1]?.id ?? null,
    indent: block.indent,
  };
  doc.getMap<unknown>(TRASHED_PAGES_MAP_NAME).set(pageId, position);
  deleteBlocks(doc, [block.id]);
}

/**
 * Moves the recorded neighbor of every `trashedPages` entry of `doc` whose neighbor is a key of `places` to the block
 * `places` gives for it (`null`: the start of the document). A caller that deletes blocks of a page after pages were
 * trashed from it (the replace of #1765 deletes the blocks its new Markdown no longer pairs) names, for each deleted
 * block, the block after which its place now lies, so a restore still finds a neighbor and puts the page back at its
 * place instead of at the end of the document. An entry that is not a valid position, or whose neighbor is not a key
 * of `places`, is left as it is.
 */
export function repointTrashedPagePositions(doc: Y.Doc, places: ReadonlyMap<string, string | null>): void {
  if (places.size === 0) return;
  const trashedPages = doc.getMap<unknown>(TRASHED_PAGES_MAP_NAME);
  for (const [pageId, stored] of [...trashedPages.entries()]) {
    const parsed = trashedPagePositionSchema.safeParse(stored);
    if (!parsed.success || parsed.data.afterBlockId === null) continue;
    const place = places.get(parsed.data.afterBlockId);
    if (place === undefined) continue;
    const moved: TrashedPagePosition = { ...parsed.data, afterBlockId: place };
    trashedPages.set(pageId, moved);
  }
}

/**
 * Puts the `page` block of `pageId` back into `doc`, with `title` as its text, and deletes the page's `trashedPages`
 * entry. A document that already holds a block for the page gets no second one. With a recorded position the block
 * returns with its recorded indent, as the first block when it was the first, otherwise after its recorded neighbor;
 * when that neighbor no longer exists, or no valid position is recorded, the block goes to the end of the document.
 * The block keeps its recorded id, or gets a new one when none is recorded or another block has taken it.
 */
function restorePageBlock(doc: Y.Doc, pageId: string, title: string): void {
  const trashedPages = doc.getMap<unknown>(TRASHED_PAGES_MAP_NAME);
  const parsed = trashedPagePositionSchema.safeParse(trashedPages.get(pageId));
  const position = parsed.success ? parsed.data : null;
  trashedPages.delete(pageId);

  const blocks = storedBlocks(doc);
  if (blocks.some((block) => block.pageId === pageId)) return;
  const neighborId = position?.afterBlockId ?? null;
  const afterBlockId =
    position !== null && (neighborId === null || blocks.some((block) => block.id === neighborId))
      ? neighborId
      : (blocks.at(-1)?.id ?? null);
  const blockId = position !== null && !getBlocksMap(doc).has(position.blockId) ? position.blockId : randomUUID();
  insertBlocks(doc, afterBlockId, [{ id: blockId, type: "page", pageId, text: title, indent: position?.indent }]);
}

/**
 * The choke point's delete hook for Pages items (issue #1723), registered by `../domainWriteHooks.ts`. It runs inside
 * the trash cascade's transaction, after the page's own soft delete, and acts on rows of the Pages system database
 * only:
 *
 * 1. the live direct subpages are selected and locked `FOR UPDATE` in one statement, in id order, the page's own
 *    deletion epoch is read at full precision (a page without live subpages skips that read), and then each subpage is
 *    trashed in that order through the choke point's `itemDeleteWithClient` with this trash's writer and acting user
 *    and with that epoch as its `deleted_at`, so its own run of this hook trashes its subpages and removes its block
 *    in turn, and every page of the tree keeps the epoch of the page the trash started at. That epoch is this
 *    transaction's `now()` unless the page joined an earlier one, as the subpage of a host does;
 * 2. the page's block is removed from the document of the item its `parentItemId` names, and its position is
 *    recorded there, in one document update authored by the writer kind (`user`, `ai_agent` or `system`).
 *
 * Step 2 writes nothing when the page's `parentItemId` is not a UUID, the parent has no page document, or that
 * document holds no block for the page. An error from either step rolls the whole trash back. The nested trash takes
 * the production queue routing, since a delete hook's context carries none.
 *
 * The rows of all direct subpages are locked before the first of them is trashed, because that trash ends in step 2
 * of the subpage's own run, which locks this page's document. A trash of one of those subpages on its own locks the
 * subpage's row first and this page's document last. With the rows taken first here, that trash either waits for its
 * row while it holds no lock, or this one waits for the row before it has locked the document; when the other trash
 * commits first, the subpage is no longer live and is left out here.
 */
export const pageItemDeleteHook: ItemDeleteHook = async (context) => {
  const { client, database, item } = context;
  if (!database.system || database.ownerModuleId !== PAGES_MODULE_ID) return;
  const childIds = await lockLiveChildPageIds(client, database.id, item.id);
  // The page's own epoch is this transaction's `now()` in a plain trash, and an earlier one when the page joined the
  // epoch of its host (`hostItemDeleteHook`); the pages below it join the epoch the page has either way.
  const deletedAtExact = childIds.length === 0 ? null : await lockItemTrashEpoch(client, database.id, item.id);
  if (childIds.length > 0 && deletedAtExact === null) throw new Error(`Trashed page ${item.id} has no deletion epoch`);
  for (const childId of childIds) {
    await itemDeleteWithClient(client, database.id, childId, {
      queueAffinity: createActionQueueAffinity(),
      actingUserId: context.actingUserId,
      writer: writerOf(context),
      ...(deletedAtExact === null ? {} : { deletedAtExact }),
    });
  }
  const parentDocId = await parentPageDocId(client, item);
  if (parentDocId === null) return;
  await mutateDocWithClient(client, parentDocId, ORIGIN_BY_WRITER_KIND[context.writerKind], (doc) =>
    removePageBlock(doc, item.id),
  );
};

/**
 * The choke point's restore hook for Pages items (issue #1723), registered by `../domainWriteHooks.ts`. It runs
 * inside the restore cascade's transaction, after the page's own restore, and acts on rows of the Pages system
 * database only:
 *
 * 1. every direct subpage that is in the Trash with exactly the page's deletion epoch (`deletedAtExact`, compared by
 *    Postgres) is restored through the choke point's `restoreItemWithClient` with this restore's queue routing,
 *    writer and acting user, so its own run of this hook continues below it; a subpage trashed at another instant
 *    stays in the Trash. The subpages are restored in descending id order, the reverse of the order the delete hook
 *    trashed them in: each of them recorded the neighbor its block had once the blocks of the subpages trashed before
 *    it were gone, so each block is put back into the document as its own trash left it;
 * 2. the page's block is put back into the document of the item its `parentItemId` names, with the page's current
 *    `title` as its text (see `restorePageBlock` for the place), in one document update authored by the writer kind.
 *
 * Step 2 writes nothing when the page's `parentItemId` is not a UUID or the parent has no page document. An error
 * from either step rolls the whole restore back.
 */
export const pageItemRestoreHook: ItemRestoreHook = async (context) => {
  const { client, database, item } = context;
  if (!database.system || database.ownerModuleId !== PAGES_MODULE_ID) return;
  const epochChildIds = await lockChildPageIdsOfEpoch(client, database.id, item.id, context.deletedAtExact);
  for (const childId of [...epochChildIds].reverse()) {
    await restoreItemWithClient(
      client,
      database.id,
      childId,
      context.queueAffinity,
      context.actingUserId,
      writerOf(context),
    );
  }
  const parentDocId = await parentPageDocId(client, item);
  if (parentDocId === null) return;
  const title: unknown = item.properties.title;
  await mutateDocWithClient(client, parentDocId, ORIGIN_BY_WRITER_KIND[context.writerKind], (doc) =>
    restorePageBlock(doc, item.id, typeof title === "string" ? title : ""),
  );
};

/**
 * The choke point's delete hook for the subpages of a host (issue #1763), registered by `../domainWriteHooks.ts`. It
 * runs inside the trash cascade's transaction, after the row's own soft delete, for every row the cascade trashes, and
 * acts on a row of any database except the Pages system database, whose rows are `pageItemDeleteHook`'s:
 *
 * 1. the live Pages items whose `parentItemId` is the row are selected and locked `FOR UPDATE` in one statement, in id
 *    order;
 * 2. the row's own deletion epoch is read at full precision, and each of those subpages is trashed in that order
 *    through the choke point's `itemDeleteWithClient` with this trash's writer and acting user and with that epoch as
 *    its `deleted_at`. `hostItemRestoreHook` finds the subpages by that epoch, also when the host's trash joined an
 *    earlier one. Each subpage's own run of `pageItemDeleteHook` trashes the live pages below it into the same
 *    epoch and takes the subpage's block out of the host's document.
 *
 * The hook returns before its first statement for a row of the Pages database, after one read when the tenant has no
 * Pages database, and after a second read when the row has no live subpage; that second read matches no row, so it
 * locks none. An error from a nested trash rolls the whole trash of the host back. The nested trash takes the
 * production queue routing, since a delete hook's context carries none.
 *
 * The cascade holds the host's row before this hook runs, and the hook locks the rows of all live subpages before it
 * trashes the first of them, for the reason `pageItemDeleteHook` states: that trash ends with a lock on the host's
 * document. docs/adr/2026-11-12-a-trashed-host-takes-its-subpages-into-its-deletion-epoch.md records the order.
 */
export const hostItemDeleteHook: ItemDeleteHook = async (context) => {
  const { client, database, item } = context;
  if (database.system && database.ownerModuleId === PAGES_MODULE_ID) return;
  const pagesDatabase = await getDatabaseByModuleId(client, PAGES_MODULE_ID);
  if (!pagesDatabase) return;
  const childIds = await lockLiveChildPageIds(client, pagesDatabase.id, item.id);
  if (childIds.length === 0) return;
  const deletedAtExact = await lockItemTrashEpoch(client, database.id, item.id);
  if (deletedAtExact === null) throw new Error(`Trashed host ${item.id} has no deletion epoch`);
  for (const childId of childIds) {
    await itemDeleteWithClient(client, pagesDatabase.id, childId, {
      queueAffinity: createActionQueueAffinity(),
      actingUserId: context.actingUserId,
      writer: writerOf(context),
      deletedAtExact,
    });
  }
};

/**
 * The choke point's restore hook for the subpages of a host (issue #1763), registered by `../domainWriteHooks.ts`. It
 * runs inside the restore cascade's transaction, after the row's own restore, for every row the cascade restores, and
 * acts on a row of any database except the Pages system database, whose rows are `pageItemRestoreHook`'s. Every Pages
 * item whose `parentItemId` is the row and that is in the Trash with exactly the row's deletion epoch
 * (`deletedAtExact`, compared by Postgres) is selected and locked `FOR UPDATE` in one statement, in id order, and
 * restored through the choke point's `restoreItemWithClient` with this restore's queue routing, writer and acting user.
 * Each subpage's own run of `pageItemRestoreHook` restores the pages of that epoch below it and puts the subpage's
 * block back into the host's document. The subpages are restored in descending id order, the reverse of the order
 * `hostItemDeleteHook` trashed them in, for the reason `pageItemRestoreHook` states. A subpage trashed at another
 * instant stays in the Trash.
 *
 * The hook returns before its first statement for a row of the Pages database, after one read when the tenant has no
 * Pages database, and after a second read when the row has no subpage of that epoch. An error from a nested restore
 * rolls the whole restore of the host back.
 */
export const hostItemRestoreHook: ItemRestoreHook = async (context) => {
  const { client, database, item } = context;
  if (database.system && database.ownerModuleId === PAGES_MODULE_ID) return;
  const pagesDatabase = await getDatabaseByModuleId(client, PAGES_MODULE_ID);
  if (!pagesDatabase) return;
  const epochChildIds = await lockChildPageIdsOfEpoch(client, pagesDatabase.id, item.id, context.deletedAtExact);
  for (const childId of [...epochChildIds].reverse()) {
    await restoreItemWithClient(
      client,
      pagesDatabase.id,
      childId,
      context.queueAffinity,
      context.actingUserId,
      writerOf(context),
    );
  }
};
