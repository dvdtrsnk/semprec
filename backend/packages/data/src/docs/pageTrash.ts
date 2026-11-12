// Trash and restore of subpages (issue #1723): the choke point's delete and restore hooks for Pages items, and the
// walk over the live pages below an item. A trashed page takes its live subpages with it and leaves its parent's
// document; a restored page brings back the subpages trashed with it and its block.
// Constrained by: docs/adr/2026-11-10-trashed-pages-leave-the-parent-document-and-record-their-position.md,
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

type TrashedPagePosition = z.infer<typeof trashedPagePositionSchema>;

/** The stored blocks of `doc` in document order, without the synthetic block an empty document is read as. */
function storedBlocks(doc: Y.Doc) {
  return readPageBlocks(doc).flatMap((block) => (block.id === null ? [] : [{ ...block, id: block.id }]));
}

/**
 * The ids of the live Pages items whose `parentItemId` is one of `parentItemIds`, in id order. A read without row
 * locks, for the walk of `collectSubpageTree`; the delete hook selects its subpages with `lockLiveChildPageIds`.
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
 * `FOR UPDATE`, so the trash of a page holds the row of every live subpage before it trashes the first of them. A
 * subpage whose own trash committed while this statement waited for its row is no longer live and is left out.
 */
async function lockLiveChildPageIds(
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
 * 1. the live direct subpages are selected and locked `FOR UPDATE` in one statement, in id order, and then each is
 *    trashed in that order through the choke point's `itemDeleteWithClient` with this trash's writer and acting user,
 *    so its own run of this hook trashes its subpages and removes its block in turn, and all of them share this
 *    transaction's `deleted_at`;
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
  for (const childId of await lockLiveChildPageIds(client, database.id, item.id)) {
    await itemDeleteWithClient(client, database.id, childId, {
      queueAffinity: createActionQueueAffinity(),
      actingUserId: context.actingUserId,
      writer: writerOf(context),
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
