import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type * as Y from "yjs";
import { BlockOperationError, convertBlocksToPages, insertBlocks, readPageBlocks } from "@semprec/block-model";
import type { PageCreateSubpageInput, PageCreateSubpageOutput } from "@semprec/shared";
import { getItemsByIdsIncludingDeleted } from "../chokePoint/itemsStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { ValidationError } from "../errors.js";
import { ensureJournalPeriodDoc } from "../journal/journalStore.js";
import type { CreatedBy, ItemRow } from "../types.js";
import { loadDocWithClient, mutateDocWithClient } from "./docPersistence.js";
import { getOrCreateDoc } from "./docsStore.js";
import { lockLiveItem } from "./lockLiveItem.js";
import { normalizePageTitle } from "./pageTitle.js";
import { ensurePagesDatabase, PAGES_MODULE_ID } from "./pagesDatabase.js";

/** A parent chain of subpages is at most this long; a longer one is refused as it cannot be walked to its host. */
const MAX_SUBPAGE_CHAIN = 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Pages item properties `createSubpage` writes; both are system-owned by the `pages` process. */
const PAGES_ALLOWED_SYSTEM_KEYS = ["title", "parentItemId"] as const;

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
 */
export async function createSubpageWithClient(
  client: PoolClient,
  input: PageCreateSubpageInput,
  origin: CreatedBy,
): Promise<PageCreateSubpageOutput> {
  const parent = await lockLiveParent(client, input.parent);
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
