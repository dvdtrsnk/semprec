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
  PageCreateSubpageInput,
  PageCreateSubpageOutput,
  PageDuplicateOutput,
  PageRenameInput,
  PageRenameOutput,
} from "@semprec/shared";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getItemsByIds, getItemsByIdsIncludingDeleted, lockItemById } from "../chokePoint/itemsStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { ensureJournalPeriodDoc } from "../journal/journalStore.js";
import type { CreatedBy, ItemRow } from "../types.js";
import { loadDocWithClient, mutateDocWithClient } from "./docPersistence.js";
import { getDocByItemId, getOrCreateDoc, readPageStatesForItems } from "./docsStore.js";
import { lockLiveItem } from "./lockLiveItem.js";
import { normalizePageTitle, PAGE_TITLE_MAX_LENGTH } from "./pageTitle.js";
import { assertAgentPageAccess, MAX_SUBPAGE_CHAIN, UUID_RE } from "./pageOwnerDatabase.js";
import { ensurePagesDatabase, PAGES_MODULE_ID } from "./pagesDatabase.js";

/** The Pages item properties `createSubpage` and `duplicatePage` write; both are system-owned by the `pages` process. */
const PAGES_ALLOWED_SYSTEM_KEYS = ["title", "parentItemId"] as const;

/** The most pages one `page.duplicate` call copies, the root of the copy included. */
export const MAX_DUPLICATE_PAGES = 500;

/** The docs catalog entry appended to the title of the root of a copy, leading space included. */
const COPY_TITLE_SUFFIX_KEY = "page.duplicate.titleSuffix";

/**
 * Resolves the parent of a new subpage to a live item whose row this transaction holds locked. For a Journal period
 * it first creates the period entry and its page in this same transaction.
 */
async function lockLiveParent(client: PoolClient, parent: PageCreateSubpageInput["parent"]): Promise<ItemRow> {
  const parentItemId =
    "journal" in parent
      ? (await ensureJournalPeriodDoc(client, parent.journal.type, parent.journal.period)).itemId
      : parent.itemId;
  return lockLiveItem(client, parentItemId);
}

/**
 * Walks `parentItemId` up from `start` through Pages items and refuses a stored cycle or a chain longer than
 * `MAX_SUBPAGE_CHAIN`. The walk ends at the first item that is not a Pages item (the host) or has no usable
 * `parentItemId`. Trashed ancestors are followed, because a cycle through a trashed page returns when it is restored.
 */
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

/** Creates an empty Pages item and its page document; returns both ids. */
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

/** Inserts a `page` block after `afterBlockId` (the end when absent); an unknown `afterBlockId` is a `ValidationError`. */
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

/**
 * Converts the named blocks of the parent's document into subpages (issue #2013): each becomes its own empty Pages
 * item and document, titled from the block's plain text, and all blocks are converted in one document write. Every
 * refusal (an unknown block, a block that is already a page, a title over the limit) happens before the first row is
 * created, and a failure of the document write rolls the created items back with the transaction. The pages are
 * returned in document order, each with the id of the block it replaced.
 */
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
 * `page.createSubpage` (issue #1676) in the caller's transaction: creates one Pages item and its page document and
 * inserts a `page` block naming it into the parent's document, so the three exist together or, if any step fails
 * (including the creation of a Journal period entry), none of them. `origin` is the caller's, derived server-side.
 * With `fromBlockIds` it converts existing blocks instead of creating one (`convertBlocksToSubpages`).
 *
 * For an agent (`agentProjectItemId`) the parent page must be writable for its project: the check follows the parent's
 * lock, because a Journal period is created by that step, and a refusal rolls the whole transaction back with it.
 */
export async function createSubpageWithClient(
  client: PoolClient,
  input: PageCreateSubpageInput,
  origin: CreatedBy,
  agentProjectItemId?: string,
): Promise<PageCreateSubpageOutput> {
  const parent = await lockLiveParent(client, input.parent);
  await assertAgentPageAccess(client, agentProjectItemId, parent.id, "write");
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
  /** Who writes the copies: derived server-side from the caller, never from a request body. */
  origin: CreatedBy;
  /** The caller's locale; it selects the suffix of the root copy's title. */
  locale: string;
}

/** One page of a copy, planned before anything is written. */
interface PlannedPage {
  /** The page this entry copies. */
  sourceId: string;
  /** The title of the copy's Pages item. */
  title: string;
  /** The planned copy this one is nested in; `null` for the root of the copy. */
  parent: PlannedPage | null;
  /** The blocks of the copy in document order; a `page` block carries the planned copy of the page it names. */
  blocks: Array<{ block: PageBlock; page: PlannedPage | null }>;
}

/** The mirrored title of a Pages item; a stored value that is not a string reads as the empty title. */
function storedTitle(page: ItemRow): string {
  const title: unknown = page.properties.title;
  return typeof title === "string" ? title : "";
}

/** The first `page` block of `blocks`, in document order, that names the page `pageItemId`. */
function firstBlockNaming(blocks: readonly PageBlock[], pageItemId: string): PageBlock | undefined {
  return blocks.find((block) => block.type === "page" && block.pageId?.toLowerCase() === pageItemId);
}

/**
 * The title of the root of a copy: the original's title followed by the docs catalog suffix of `locale` (English for
 * any locale but Czech). The original's title is cut at its end where the two together would exceed
 * `PAGE_TITLE_MAX_LENGTH`, so the suffix is always whole.
 */
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

/**
 * Resolves `pageItemId` to a live item of the Pages database without locking it. A missing, trashed or foreign item is
 * the `NotFoundError` `lockLiveItem` gives; a live item of any other database (a host) is a `ValidationError` on
 * `pageItemId`.
 */
async function readLivePage(client: PoolClient, pageItemId: string): Promise<ItemRow> {
  const [page] = await getItemsByIds(client, [pageItemId]);
  if (!page) throw new NotFoundError("Item not found", { resource: "item", itemId: pageItemId });
  const pagesDatabase = await getDatabaseByModuleId(client, PAGES_MODULE_ID);
  if (page.databaseId !== pagesDatabase?.id) {
    throw new ValidationError("This item is not a subpage", { field: "pageItemId", reason: "not_a_page" });
  }
  return page;
}

/** The real blocks of the page document of `itemId` in document order, read without locking or compacting it; none when the item has no page document. */
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
 * The title of `page` as the document of its parent `parentItemId` shows it now: the plain text of the first block that
 * names the page, normalized and cut to the length limit the way the mirror job stores it. That block is the source of
 * a title and the item's `title` a mirror that lags it
 * (`docs/adr/2026-10-29-subpages-are-items-of-a-hidden-pages-database.md`, decision 4), so the mirror answers only
 * for a page no block names (an orphan). `page` is the row the caller holds locked; the document is read without a
 * lock.
 */
async function currentTitle(client: PoolClient, parentItemId: string, page: ItemRow): Promise<string> {
  const named = firstBlockNaming(await readStoredPageBlocks(client, parentItemId), page.id);
  if (!named) return storedTitle(page);
  return normalizePageTitle(named.text.map((run) => run.insert).join(""), { truncate: true });
}

/** The id of the item a `page` block names, in the lower case item ids are stored in; `null` when its `pageId` is not an id. */
function namedPageId(block: PageBlock): string | null {
  return block.pageId !== null && UUID_RE.test(block.pageId) ? block.pageId.toLowerCase() : null;
}

/** Whether `sourceId` is the page `page` copies or one of the pages its planned ancestors copy. */
function isOnPath(page: PlannedPage, sourceId: string): boolean {
  for (let current: PlannedPage | null = page; current !== null; current = current.parent) {
    if (current.sourceId === sourceId) return true;
  }
  return false;
}

/**
 * Plans the copy of `original` and of every page nested in it, breadth first and without writing. A `page` block is
 * followed when its `pageId` names a live item of the Pages database that is not already on the path from the root of
 * the copy (a reference back to an ancestor would never end); every other `page` block is left out of the copy. A page
 * named by two blocks is planned once per block. Planning the page after `MAX_DUPLICATE_PAGES` is a `ValidationError`
 * on `pageItemId`. Returns the root of the plan; the nested copies hang off its `page` blocks.
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

/** The copy of a block that is not a `page` block: its type, indent, `done` and text runs under an id the write assigns. */
function copyBlockInput(block: PageBlock): NewBlockInput {
  return {
    type: block.type,
    indent: block.indent,
    text: block.text,
    ...(block.type === "todo" ? { done: block.done } : {}),
  };
}

/**
 * `page.duplicate` (issue #1722) in the caller's transaction: copies the subpage `pageItemId` and every page nested in
 * it as new Pages items with new documents and new block ids, and inserts the `page` block of the root of the copy into
 * the parent's document right after the first block that names the original, at that block's indent, or at the end
 * when no block names it. The root of the copy is titled with the original's title as its parent shows it
 * (`currentTitle`) followed by the suffix; only the root gets the suffix. `origin` authors every document write.
 *
 * The parent's row and then the original's row are locked and checked live, in the order
 * `docs/adr/2026-11-10-page-duplication-copies-the-subtree-as-new-pages.md` records; the title of the original, the
 * nested pages and the copied documents are read after that, without locks. The whole tree is planned before the first
 * row is created (`planPageCopy`), so a refusal there writes nothing, and a failure of any later step rolls every
 * created row back with the transaction.
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

/**
 * Locks the row of the item `page` names as its parent, whether live or trashed, and returns it; `null` when
 * `parentItemId` is not an id or names no item of the tenant.
 */
async function lockParentRow(client: PoolClient, page: ItemRow): Promise<ItemRow | null> {
  const parentItemId: unknown = page.properties.parentItemId;
  if (typeof parentItemId !== "string" || !UUID_RE.test(parentItemId)) return null;
  const [parent] = await getItemsByIdsIncludingDeleted(client, [parentItemId]);
  return parent ? lockItemById(client, parent.databaseId, parent.id) : null;
}

/**
 * Gives the first `page` block of `doc` that names `pageItemId` the plain text `title`, through the block model's
 * writer with the block's own indent and `pageId`. A document with no such block, or whose block already reads
 * `title`, is left unchanged.
 */
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
 * `page.rename` (issue #1725) in the caller's transaction: stores the normalized `title` on the Pages item
 * `pageItemId` and as the text of the first block of the parent's document that names the page, so both change or,
 * if the document write fails, neither does. A page no block names (an orphan), and a page whose parent has no
 * document or is gone, has only its item renamed. A title equal to the stored one writes nothing. `origin` authors
 * the document write; the item's `title` is written under the `pages` owner process.
 *
 * The parent's row, when there is one, and then the page's row are locked before the title is compared, in the order
 * `docs/adr/2026-11-10-page-rename-writes-the-item-title-and-the-parent-block-together.md` records.
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
