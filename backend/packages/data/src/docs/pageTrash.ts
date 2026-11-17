// Trash/restore hooks for Pages items and their hosts. A trashed page or host takes its live subpages into its own
// deletion epoch and the page leaves its parent's document; a restore brings back exactly that epoch's subpages.
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

/** Per trashed subpage id, where its `page` block stood. */
const TRASHED_PAGES_MAP_NAME = "trashedPages";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORIGIN_BY_WRITER_KIND: Readonly<Record<WriterKind, CreatedBy>> = {
  user: "user",
  agent: "ai_agent",
  system: "system",
};

/** The map lives in a synced (client-writable) document, so entries are parsed before use. */
const trashedPagePositionSchema = z.object({
  blockId: z.string().min(1),
  afterBlockId: z.string().nullable(),
  indent: z.number().int().min(MIN_INDENT).max(MAX_INDENT),
});

export type TrashedPagePosition = z.infer<typeof trashedPagePositionSchema>;

/** Leaves the entry in place, so a restore still finds it. */
export function readTrashedPagePosition(doc: Y.Doc, pageId: string): TrashedPagePosition | null {
  const parsed = trashedPagePositionSchema.safeParse(doc.getMap<unknown>(TRASHED_PAGES_MAP_NAME).get(pageId));
  return parsed.success ? parsed.data : null;
}

function storedBlocks(doc: Y.Doc) {
  return readPageBlocks(doc).flatMap((block) => (block.id === null ? [] : [{ ...block, id: block.id }]));
}

/** No row locks; the delete hooks use `lockLiveChildPageIds`. */
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
 * Locks every live subpage row before the caller trashes the first, in id order. A subpage whose own trash committed
 * while this waited is no longer live and is left out. `replacePageMarkdown` takes the same locks before loading the
 * host's document.
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

/** Locks in the same statement, so the matched epoch is still the row's epoch when the caller restores it. */
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
 * Live pages below `rootItemId` (root excluded), breadth first; exactly what a trash of the root takes with it. A live
 * page below a trashed one is not reached. Stored `parentItemId` cycles terminate because ids are visited once.
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

async function parentPageDocId(client: PoolClient, page: ItemRow): Promise<string | null> {
  const parentItemId: unknown = page.properties.parentItemId;
  if (typeof parentItemId !== "string" || !UUID_RE.test(parentItemId)) return null;
  const doc = await getDocByItemId(client, parentItemId);
  return doc?.kind === "page" ? doc.id : null;
}

function writerOf(context: { writerKind: WriterKind; agentRunId?: string }): WriterIdentity {
  return {
    writerKind: context.writerKind,
    ...(context.agentRunId === undefined ? {} : { agentRunId: context.agentRunId }),
  };
}

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
 * For a caller that deletes blocks: `places` maps each deleted block to the block its place now follows (`null`: start
 * of document), so a later restore lands where the page stood rather than at the end.
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
 * Never adds a second block for the page. Falls back to the end of the document when the recorded neighbor is gone or
 * no valid position exists, and to a new id when the recorded one is taken.
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
 * Runs in the trash cascade's transaction after the page's soft delete: trashes live subpages into the page's exact
 * epoch (recursing through this hook), then removes the page's block from its parent's document and records its
 * position. The nested trash takes the production queue routing because a delete hook's context carries none.
 *
 * All subpage rows are locked before the first is trashed: each nested trash ends by locking this page's document,
 * while a standalone subpage trash locks its row first and the document last, so rows-first avoids a deadlock.
 */
export const pageItemDeleteHook: ItemDeleteHook = async (context) => {
  const { client, database, item } = context;
  if (!database.system || database.ownerModuleId !== PAGES_MODULE_ID) return;
  const childIds = await lockLiveChildPageIds(client, database.id, item.id);
  // `now()` for a plain trash, or the host's earlier epoch; subpages join whichever the page has.
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
 * Restores subpages of exactly the page's epoch (one trashed at another instant stays), then puts the page's block
 * back. Subpages restore in reverse trash order: each recorded its neighbor after earlier siblings' blocks were gone,
 * so reversing replays the document state each trash saw.
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
 * For rows of any non-Pages database: trashes the host's live subpages into the host's exact epoch, so
 * `hostItemRestoreHook` can find them. Subpage rows are locked first for the reason `pageItemDeleteHook` states.
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

/** Restores the host's subpages of exactly its epoch, in reverse trash order (see `pageItemRestoreHook`). */
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
