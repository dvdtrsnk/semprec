import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import * as Y from "yjs";
import {
  BlockOperationError,
  convertBlocksToPages,
  insertBlocks,
  readPageBlocks,
  writeBlock,
  type NewBlockInput,
  type PageBlock,
} from "@semprec/block-model";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import type {
  PageConvertToBlockInput,
  PageConvertToBlockOutput,
  PageCreateSubpageInput,
  PageCreateSubpageOutput,
  PageDuplicateOutput,
  PageRenameInput,
  PageRenameOutput,
} from "@semprec/shared";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemsByIds, getItemsByIdsIncludingDeleted, lockItemById } from "../chokePoint/itemsStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { ensureJournalPeriodDoc } from "../journal/journalStore.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import type { CreatedBy, ItemRow } from "../types.js";
import { loadDocWithClient, mutateDocWithClient } from "./docPersistence.js";
import { getDocByItemId, getOrCreateDoc, readPageStatesForItems } from "./docsStore.js";
import { lockLiveItem } from "./lockLiveItem.js";
import { normalizePageTitle, PAGE_TITLE_MAX_LENGTH } from "./pageTitle.js";
import type { DatabaseReader } from "../agentGrants/agentDatabaseAccess.js";
import { assertAgentPageAccess, MAX_SUBPAGE_CHAIN, UUID_RE } from "./pageOwnerDatabase.js";
import { ensurePagesDatabase, PAGES_MODULE_ID } from "./pagesDatabase.js";
import { collectSubpageTree, lockLiveChildPageIds, readTrashedPagePosition } from "./pageTrash.js";

/** System-owned by the `pages` process. */
const PAGES_ALLOWED_SYSTEM_KEYS = ["title", "parentItemId"] as const;

/** Root of the copy included. */
export const MAX_DUPLICATE_PAGES = 500;

const COPY_TITLE_SUFFIX_KEY = "page.duplicate.titleSuffix";

/** For a Journal period it first creates the period entry and its page in this same transaction. */
async function lockLiveParent(client: PoolClient, parent: PageCreateSubpageInput["parent"]): Promise<ItemRow> {
  const parentItemId =
    "journal" in parent
      ? (await ensureJournalPeriodDoc(client, parent.journal.type, parent.journal.period)).itemId
      : parent.itemId;
  return lockLiveItem(client, parentItemId);
}

/** Trashed ancestors are followed, because a cycle through a trashed page returns when it is restored. */
async function assertParentChainIsAcyclic(client: PoolClient, pagesDatabaseId: string, start: ItemRow): Promise<void> {
  const visited = new Set<string>();
  let current: ItemRow = start;
  while (current.databaseId === pagesDatabaseId) {
    if (visited.has(current.id)) {
      throw new ValidationError("The parent chain of this page forms a cycle", { field: "parent" });
    }
    visited.add(current.id);
    if (visited.size > MAX_SUBPAGE_CHAIN) {
      throw new ValidationError(`The parent chain of this page is longer than ${MAX_SUBPAGE_CHAIN}`, {
        field: "parent",
      });
    }
    const next: unknown = current.properties.parentItemId;
    if (typeof next !== "string" || !UUID_RE.test(next)) return;
    const [ancestor] = await getItemsByIdsIncludingDeleted(client, [next]);
    if (!ancestor) return;
    current = ancestor;
  }
}

async function createPagesItem(
  client: PoolClient,
  pagesDatabaseId: string,
  parentItemId: string,
  title: string,
): Promise<{ pageItemId: string; docId: string }> {
  const item = await createItemWithClient(
    client,
    { databaseId: pagesDatabaseId, properties: { title, parentItemId } },
    { allowedSystemKeys: PAGES_ALLOWED_SYSTEM_KEYS, systemOwnerProcess: PAGES_MODULE_ID },
  );
  const doc = await getOrCreateDoc(client, item.id, "page");
  return { pageItemId: item.id, docId: doc.id };
}

function insertPageBlock(
  doc: Y.Doc,
  afterBlockId: string | undefined,
  page: { blockId: string; pageItemId: string; title: string },
): void {
  const afterId =
    afterBlockId ??
    readPageBlocks(doc)
      .filter((block) => !block.synthetic && block.id !== null)
      .at(-1)?.id ??
    null;
  try {
    insertBlocks(doc, afterId, [{ id: page.blockId, type: "page", pageId: page.pageItemId, text: page.title }]);
  } catch (error) {
    if (error instanceof BlockOperationError && error.code === "invalid_after_id") {
      throw new ValidationError("afterBlockId does not name a block of the parent page", { field: "afterBlockId" });
    }
    throw error;
  }
}

/** Every refusal happens before the first row is created; all blocks convert in one document write. */
async function convertBlocksToSubpages(
  client: PoolClient,
  parent: ItemRow,
  parentDocId: string,
  pagesDatabaseId: string,
  fromBlockIds: readonly string[],
  origin: CreatedBy,
): Promise<PageCreateSubpageOutput> {
  const inspected = await loadDocWithClient(client, parentDocId);
  let planned: Array<{ blockId: string; title: string }>;
  try {
    const blocks = readPageBlocks(inspected).filter((block) => !block.synthetic && block.id !== null);
    const wanted = new Set(fromBlockIds);
    const selected = blocks.filter((block) => block.id !== null && wanted.has(block.id));
    if (
      wanted.size !== fromBlockIds.length ||
      selected.length !== wanted.size ||
      selected.some((block) => block.type === "page")
    ) {
      throw new ValidationError("fromBlockIds must name each existing non-page block of the parent page once", {
        field: "fromBlockIds",
      });
    }
    planned = selected.map((block) => ({
      blockId: block.id ?? "",
      title: normalizePageTitle(block.text.map((run) => run.insert).join("")),
    }));
  } finally {
    inspected.destroy();
  }

  const pages: PageCreateSubpageOutput["pages"] = [];
  for (const { blockId, title } of planned) {
    pages.push({ ...(await createPagesItem(client, pagesDatabaseId, parent.id, title)), blockId });
  }
  const pageItemIds = new Map(pages.map((page) => [page.blockId, page.pageItemId]));
  await mutateDocWithClient(client, parentDocId, origin, (doc) =>
    convertBlocksToPages(doc, fromBlockIds, (blockId) => pageItemIds.get(blockId) ?? ""),
  );
  return { pages };
}

/**
 * `page.createSubpage` in the caller's transaction: the item, its document and the parent's `page` block exist
 * together or not at all. The `reader` access check follows the parent's lock because that step may create a Journal
 * period; a refusal rolls it back.
 */
export async function createSubpageWithClient(
  client: PoolClient,
  input: PageCreateSubpageInput,
  origin: CreatedBy,
  reader?: DatabaseReader,
): Promise<PageCreateSubpageOutput> {
  const parent = await lockLiveParent(client, input.parent);
  await assertAgentPageAccess(client, reader, parent.id, "write");
  const parentDoc = await getOrCreateDoc(client, parent.id, "page");
  const pagesDatabase = await ensurePagesDatabase(client);
  await assertParentChainIsAcyclic(client, pagesDatabase.id, parent);
  if (input.fromBlockIds !== undefined) {
    return convertBlocksToSubpages(client, parent, parentDoc.id, pagesDatabase.id, input.fromBlockIds, origin);
  }

  const title = normalizePageTitle(input.title ?? "");
  const { pageItemId, docId } = await createPagesItem(client, pagesDatabase.id, parent.id, title);
  const blockId = randomUUID();
  await mutateDocWithClient(client, parentDoc.id, origin, (doc) =>
    insertPageBlock(doc, input.afterBlockId, { blockId, pageItemId, title }),
  );
  return { pages: [{ pageItemId, docId, blockId }] };
}

export interface DuplicatePageOptions {
  /** Derived server-side from the caller, never from a request body. */
  origin: CreatedBy;
  /** Selects the suffix of the root copy's title. */
  locale: string;
}

interface PlannedPage {
  sourceId: string;
  title: string;
  /** `null` for the root of the copy. */
  parent: PlannedPage | null;
  /** A `page` block carries the planned copy of the page it names. */
  blocks: Array<{ block: PageBlock; page: PlannedPage | null }>;
}

function storedTitle(page: ItemRow): string {
  const title: unknown = page.properties.title;
  return typeof title === "string" ? title : "";
}

function firstBlockNaming(blocks: readonly PageBlock[], pageItemId: string): PageBlock | undefined {
  return blocks.find((block) => block.type === "page" && block.pageId?.toLowerCase() === pageItemId);
}

/** The original's title is truncated so the localized suffix always fits whole. */
async function copyTitle(title: string, locale: string): Promise<string> {
  const catalogs = await loadModuleCatalogs(import.meta.url);
  const suffix = resolveCatalogLabel(
    null,
    locale === "cs" ? catalogs.cs : catalogs.en,
    catalogs.en,
    COPY_TITLE_SUFFIX_KEY,
  );
  const room = PAGE_TITLE_MAX_LENGTH - Array.from(suffix).length;
  return normalizePageTitle(Array.from(title).slice(0, room).join("").trimEnd() + suffix);
}

/** Does not lock. A live item of another database (a host) is a `ValidationError`, not a `NotFoundError`. */
async function readLivePage(client: PoolClient, pageItemId: string): Promise<ItemRow> {
  const [page] = await getItemsByIds(client, [pageItemId]);
  if (!page) throw new NotFoundError("Item not found", { resource: "item", itemId: pageItemId });
  const pagesDatabase = await getDatabaseByModuleId(client, PAGES_MODULE_ID);
  if (page.databaseId !== pagesDatabase?.id) {
    throw new ValidationError("This item is not a subpage", { field: "pageItemId", reason: "not_a_page" });
  }
  return page;
}

/** Reads without locking or compacting the document. */
async function readStoredPageBlocks(client: PoolClient, itemId: string): Promise<PageBlock[]> {
  const [state] = await readPageStatesForItems(client, [itemId]);
  if (!state) return [];
  const doc = new Y.Doc();
  try {
    if (state.snapshot) Y.applyUpdate(doc, state.snapshot);
    for (const update of state.updates) Y.applyUpdate(doc, update);
    return readPageBlocks(doc).filter((block) => !block.synthetic);
  } finally {
    doc.destroy();
  }
}

/**
 * The parent's first block naming the page is the source of the title; the item's `title` is a lagging mirror, used
 * only for an orphan no block names.
 */
async function currentTitle(client: PoolClient, parentItemId: string, page: ItemRow): Promise<string> {
  const named = firstBlockNaming(await readStoredPageBlocks(client, parentItemId), page.id);
  if (!named) return storedTitle(page);
  return normalizePageTitle(named.text.map((run) => run.insert).join(""), { truncate: true });
}

/** Lowercased, as item ids are stored; `null` when `pageId` is not a UUID. */
function namedPageId(block: PageBlock): string | null {
  return block.pageId !== null && UUID_RE.test(block.pageId) ? block.pageId.toLowerCase() : null;
}

function isOnPath(page: PlannedPage, sourceId: string): boolean {
  for (let current: PlannedPage | null = page; current !== null; current = current.parent) {
    if (current.sourceId === sourceId) return true;
  }
  return false;
}

/**
 * Breadth first, without writing. A `page` block naming an ancestor on the current path is dropped (it would never
 * end), as is one naming no live Pages item. A page named by two blocks is planned once per block.
 */
async function planPageCopy(client: PoolClient, original: ItemRow, rootTitle: string): Promise<PlannedPage> {
  const root: PlannedPage = { sourceId: original.id, title: rootTitle, parent: null, blocks: [] };
  const planned = [root];
  for (const page of planned) {
    const blocks = await readStoredPageBlocks(client, page.sourceId);
    const namedIds = blocks.flatMap((block) => namedPageId(block) ?? []);
    const livePages = new Map(
      (await getItemsByIds(client, [...new Set(namedIds)]))
        .filter((item) => item.databaseId === original.databaseId)
        .map((item) => [item.id, item]),
    );
    for (const block of blocks) {
      if (block.type !== "page") {
        page.blocks.push({ block, page: null });
        continue;
      }
      const namedId = namedPageId(block);
      const source = namedId === null ? undefined : livePages.get(namedId);
      if (!source || isOnPath(page, source.id)) continue;
      if (planned.length >= MAX_DUPLICATE_PAGES) {
        throw new ValidationError(
          `A page with more than ${MAX_DUPLICATE_PAGES} pages in its tree cannot be duplicated`,
          {
            field: "pageItemId",
            reason: "too_many_pages",
          },
        );
      }
      const nested: PlannedPage = { sourceId: source.id, title: storedTitle(source), parent: page, blocks: [] };
      planned.push(nested);
      page.blocks.push({ block, page: nested });
    }
  }
  return root;
}

function copyBlockInput(block: PageBlock): NewBlockInput {
  return {
    type: block.type,
    indent: block.indent,
    text: block.text,
    ...(block.type === "todo" ? { done: block.done } : {}),
  };
}

/**
 * `page.duplicate` in the caller's transaction: copies the subtree as new pages and inserts the root copy's block right
 * after the first block naming the original (or at the end).
 *
 * Lock order: the parent row, then the original's row; everything else is read without locks. The whole tree is
 * planned before the first row is created, so a refusal writes nothing.
 */
export async function duplicatePageWithClient(
  client: PoolClient,
  pageItemId: string,
  options: DuplicatePageOptions,
): Promise<PageDuplicateOutput> {
  const visible = await readLivePage(client, pageItemId);
  const parentItemId: unknown = visible.properties.parentItemId;
  if (typeof parentItemId !== "string" || !UUID_RE.test(parentItemId)) {
    throw new NotFoundError("Item not found", { resource: "item", itemId: pageItemId });
  }
  const parent = await lockLiveItem(client, parentItemId);
  const original = await lockItemById(client, visible.databaseId, pageItemId);
  if (!original || original.deletedAt !== null) {
    throw new NotFoundError("Item not found", { resource: "item", itemId: pageItemId });
  }
  const rootTitle = await copyTitle(await currentTitle(client, parent.id, original), options.locale);
  const root = await planPageCopy(client, original, rootTitle);

  const parentDoc = await getOrCreateDoc(client, parent.id, "page");
  const rootCopy = await createPagesItem(client, original.databaseId, parent.id, rootTitle);
  const queue = [{ page: root, copy: rootCopy }];
  for (const { page, copy } of queue) {
    const inputs: NewBlockInput[] = [];
    for (const { block, page: nestedPage } of page.blocks) {
      if (nestedPage === null) {
        inputs.push(copyBlockInput(block));
        continue;
      }
      const nestedCopy = await createPagesItem(client, original.databaseId, copy.pageItemId, nestedPage.title);
      queue.push({ page: nestedPage, copy: nestedCopy });
      inputs.push({ type: "page", indent: block.indent, text: block.text, pageId: nestedCopy.pageItemId });
    }
    await mutateDocWithClient(client, copy.docId, options.origin, (doc) => insertBlocks(doc, null, inputs));
  }

  const blockId = randomUUID();
  await mutateDocWithClient(client, parentDoc.id, options.origin, (doc) => {
    const blocks = readPageBlocks(doc).filter((block) => !block.synthetic);
    const named = firstBlockNaming(blocks, original.id);
    insertBlocks(doc, (named ?? blocks.at(-1))?.id ?? null, [
      { id: blockId, type: "page", indent: named?.indent ?? 0, text: rootTitle, pageId: rootCopy.pageItemId },
    ]);
  });
  return { pageItemId: rootCopy.pageItemId, docId: rootCopy.docId, blockId };
}

/** Locks the parent row whether live or trashed. */
async function lockParentRow(client: PoolClient, page: ItemRow): Promise<ItemRow | null> {
  const parentItemId: unknown = page.properties.parentItemId;
  if (typeof parentItemId !== "string" || !UUID_RE.test(parentItemId)) return null;
  const [parent] = await getItemsByIdsIncludingDeleted(client, [parentItemId]);
  return parent ? lockItemById(client, parent.databaseId, parent.id) : null;
}

function retitlePageBlock(doc: Y.Doc, pageItemId: string, title: string): void {
  for (const block of readPageBlocks(doc)) {
    if (block.id === null || block.pageId?.toLowerCase() !== pageItemId) continue;
    if (block.text.map((run) => run.insert).join("") !== title) {
      writeBlock(doc, { id: block.id, type: "page", indent: block.indent, pageId: block.pageId, text: title });
    }
    return;
  }
}

/**
 * `page.rename` in the caller's transaction: the item title and the parent's first block naming the page change
 * together or not at all. Lock order: the parent row (if any), then the page row, before the title is compared.
 */
export async function renamePageWithClient(
  client: PoolClient,
  input: PageRenameInput,
  origin: CreatedBy,
): Promise<PageRenameOutput> {
  const visible = await readLivePage(client, input.pageItemId);
  const title = normalizePageTitle(input.title);
  const parent = await lockParentRow(client, visible);
  const page = await lockItemById(client, visible.databaseId, visible.id);
  if (!page || page.deletedAt !== null) {
    throw new NotFoundError("Item not found", { resource: "item", itemId: input.pageItemId });
  }
  if (storedTitle(page) === title) return { pageItemId: page.id, title };

  await updateItemWithClient(
    client,
    { databaseId: page.databaseId, itemId: page.id, propertiesPatch: { title } },
    { allowedSystemKeys: ["title"], systemOwnerProcess: PAGES_MODULE_ID },
  );
  const parentDoc = parent ? await getDocByItemId(client, parent.id) : null;
  if (parentDoc) {
    await mutateDocWithClient(client, parentDoc.id, origin, (doc) => retitlePageBlock(doc, page.id, title));
  }
  return { pageItemId: page.id, title };
}

export interface ConvertPageToBlockOptions {
  /** Derived server-side from the caller, never from a request body. */
  origin: CreatedBy;
  writer: WriterIdentity;
  actingUserId?: string;
}

function notAConvertibleBlock(reason: string): ValidationError {
  return new ValidationError("blockId must name the page block of a live subpage of the parent page", {
    field: "blockId",
    reason,
  });
}

/**
 * Locks level by level, each in id order, so the call never holds a row below a page it waits for. A page created
 * below a locked row afterwards waits for this transaction.
 */
async function lockSubpageTree(client: PoolClient, pagesDatabaseId: string, rootItemId: string): Promise<void> {
  const visited = new Set([rootItemId]);
  let frontier = [rootItemId];
  while (frontier.length > 0) {
    const level: string[] = [];
    for (const parentId of frontier) {
      for (const childId of await lockLiveChildPageIds(client, pagesDatabaseId, parentId)) {
        if (visited.has(childId)) continue;
        visited.add(childId);
        level.push(childId);
      }
    }
    frontier = level;
  }
}

/** `parent` and `page` rows are locked. */
export interface PageConvertPlan {
  parent: ItemRow;
  parentDocId: string;
  block: PageBlock;
  page: ItemRow;
  title: string;
  /** The page and every live page below it. */
  trashedPageCount: number;
}

/**
 * Every refusal of `page.convertToBlock` before it writes; leaves the needed rows locked.
 *
 * `blockId` must be the first block naming the subpage, because the trash hook removes the first block naming a page.
 * The tree is locked before it is counted against `confirmedPageCount`, so a concurrent subpage creation either
 * committed first and is counted, or waits and then finds its parent trashed.
 */
export async function planPageConvertToBlock(
  client: PoolClient,
  input: PageConvertToBlockInput,
  agentProjectItemId: string | undefined,
): Promise<PageConvertPlan> {
  const parent = await lockLiveItem(client, input.parentItemId);
  await assertAgentPageAccess(client, agentProjectItemId, parent.id, "write");

  const parentDoc = await getDocByItemId(client, parent.id);
  const blocks = parentDoc?.kind === "page" ? await readStoredPageBlocks(client, parent.id) : [];
  const block = blocks.find((candidate) => candidate.id === input.blockId);
  if (!parentDoc || !block) {
    throw new ValidationError("blockId does not name a block of the parent page", { field: "blockId" });
  }
  if (block.type !== "page") throw notAConvertibleBlock("not_a_page_block");
  const pageId = namedPageId(block);
  if (pageId === null || firstBlockNaming(blocks, pageId)?.id !== block.id) throw notAConvertibleBlock("not_a_subpage");

  const pagesDatabase = await getDatabaseByModuleId(client, PAGES_MODULE_ID);
  const [named] = await getItemsByIds(client, [pageId]);
  const namedParent: unknown = named?.properties.parentItemId;
  if (
    !named ||
    named.databaseId !== pagesDatabase?.id ||
    typeof namedParent !== "string" ||
    namedParent.toLowerCase() !== parent.id
  ) {
    throw notAConvertibleBlock("not_a_subpage");
  }
  const page = await lockItemById(client, named.databaseId, named.id);
  if (!page || page.deletedAt !== null) throw notAConvertibleBlock("not_a_subpage");

  await lockSubpageTree(client, page.databaseId, page.id);
  const trashedPageCount = (await collectSubpageTree(client, page.id)).length + 1;
  if (trashedPageCount !== input.confirmedPageCount) {
    throw new ConflictError("The number of pages this would trash is not the number that was confirmed", {
      reason: "page_count_mismatch",
      currentPageCount: trashedPageCount,
    });
  }
  const title = normalizePageTitle(block.text.map((run) => run.insert).join(""), { truncate: true });
  return { parent, parentDocId: parentDoc.id, block, page, title, trashedPageCount };
}

/**
 * `page.convertToBlock`: trashes the page tree through the choke point (its Pages hook removes the block and records
 * where it stood), then inserts a new block with a new id at that recorded place. A later restore puts the page block
 * back; the new block stays. One transaction, so no page is trashed unless the new block is written.
 */
export async function convertPageToBlockWithClient(
  client: PoolClient,
  input: PageConvertToBlockInput,
  options: ConvertPageToBlockOptions,
): Promise<PageConvertToBlockOutput> {
  const { parentDocId, block, page, title, trashedPageCount } = await planPageConvertToBlock(
    client,
    input,
    options.writer.agentProjectItemId,
  );
  await itemDeleteWithClient(client, page.databaseId, page.id, {
    queueAffinity: createActionQueueAffinity(),
    actingUserId: options.actingUserId,
    writer: options.writer,
  });

  const newBlockId = randomUUID();
  await mutateDocWithClient(client, parentDocId, options.origin, (doc) => {
    const position = readTrashedPagePosition(doc, page.id);
    // Guards a document that changed between the plan's read and the hook's write; throwing rolls the trash back.
    if (position === null || position.blockId !== block.id) throw notAConvertibleBlock("block_changed");
    insertBlocks(doc, position.afterBlockId, [
      { id: newBlockId, type: input.type, indent: position.indent, text: title },
    ]);
  });
  return { blockId: newBlockId, trashedPageCount };
}
