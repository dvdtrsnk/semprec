import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { getItemsByIds, lockItemById } from "../chokePoint/itemsStore.js";
import type {
  PageConvertToBlockInput,
  PageConvertToBlockOutput,
  PageCreateSubpageInput,
  PageCreateSubpageOutput,
  PageDuplicateOutput,
  PageRenameInput,
  PageRenameOutput,
  PageRestoreOutput,
} from "@semprec/shared";
import type { CreatedBy, DocKind, DocRow } from "../types.js";
import { deleteBlocks, readPageBlocks } from "@semprec/block-model";
import * as docsStore from "./docsStore.js";
import { loadDoc, mutateDoc, mutateDocWithClient } from "./docPersistence.js";
import * as blocks from "./blocks.js";
import type { BlockInput, BlockData } from "./blocks.js";
import * as canvas from "./canvas.js";
import type { CanvasElementInput, CanvasElementData } from "./canvas.js";
import { openDocVersionAt } from "./docHistory.js";
import { readPageSummary } from "./pageSummary.js";
import { restorePageVersionWithClient } from "./docPageRestore.js";
import {
  convertPageToBlockWithClient,
  createSubpageWithClient,
  duplicatePageWithClient,
  renamePageWithClient,
  type ConvertPageToBlockOptions,
  type DuplicatePageOptions,
} from "./pageOperations.js";
import {
  insertPageMarkdown,
  readPageMarkdown,
  replacePageMarkdown,
  type InsertPageMarkdownInput,
  type ReplacePageMarkdownInput,
} from "./pageMarkdown.js";
import { listPageChanges, type ListPageChangesOptions, type PageChange } from "./pageChanges.js";
import type { DatabaseReader } from "../agentGrants/agentDatabaseAccess.js";
import { assertAgentPageAccess } from "./pageOwnerDatabase.js";

function assertKind(doc: DocRow, expected: DocKind): void {
  if (doc.kind !== expected) {
    throw new ValidationError(`Doc for item ${doc.itemId} is '${doc.kind}', not '${expected}'`, {
      itemId: doc.itemId,
      kind: doc.kind,
    });
  }
}

/** For a caller whose block append must commit atomically with its own structured-data write. */
export async function putBlockWithClient(
  client: PoolClient,
  itemId: string,
  block: BlockInput,
  origin: CreatedBy,
): Promise<boolean> {
  const doc = await docsStore.getOrCreateDoc(client, itemId, "page");
  return mutateDocWithClient(client, doc.id, origin, (ydoc) => {
    const inserted = blocks.getBlock(ydoc, block.id) === null;
    blocks.putBlock(ydoc, block);
    return inserted;
  });
}

/**
 * For a caller whose block removal must commit atomically with its own write (e.g. undoing a confirmed proposal).
 * Skips ids the page no longer holds and returns the ids removed. The caller holds the page item's row lock.
 */
export async function deleteBlocksWithClient(
  client: PoolClient,
  itemId: string,
  blockIds: readonly string[],
  origin: CreatedBy,
): Promise<string[]> {
  const doc = await docsStore.getDocByItemId(client, itemId);
  if (!doc) return [];
  assertKind(doc, "page");
  return mutateDocWithClient(client, doc.id, origin, (ydoc) => {
    const held = new Set(readPageBlocks(ydoc).flatMap((block) => (block.id === null ? [] : [block.id])));
    const present = blockIds.filter((id) => held.has(id));
    if (present.length > 0) deleteBlocks(ydoc, present);
    return present;
  });
}

export interface DocVersion {
  kind: DocKind;
  blocks?: BlockData[];
  elements?: CanvasElementData[];
}

/**
 * The CRDT document store: a persistence mechanism deliberately separate from the structured-data choke point, with
 * this factory as its single writer. `origin` (including `"ai_agent"`) is stored as `created_by` for attribution.
 */
export function createDocStore(pool: Pool) {
  return {
    async getOrCreateDoc(itemId: string, kind: DocKind): Promise<DocRow> {
      return withTransaction(pool, (client) => docsStore.getOrCreateDoc(client, itemId, kind));
    },

    async getDoc(itemId: string): Promise<DocRow | null> {
      return withTransaction(pool, (client) => docsStore.getDocByItemId(client, itemId));
    },

    /** Every method taking `reader` checks its access to the page's owner database first, in the same transaction. */
    async getPageSummary(itemId: string, locale: string, limit?: number, reader?: DatabaseReader) {
      return withTransaction(pool, async (client) => {
        await assertAgentPageAccess(client, reader, itemId, "read");
        return readPageSummary(client, itemId, locale, limit);
      });
    },

    async readPageMarkdown(itemId: string, reader?: DatabaseReader) {
      return withTransaction(pool, async (client) => {
        await assertAgentPageAccess(client, reader, itemId, "read");
        return readPageMarkdown(client, itemId);
      });
    },

    async insertPageMarkdown(itemId: string, input: InsertPageMarkdownInput, reader?: DatabaseReader) {
      return withTransaction(pool, async (client) => {
        await assertAgentPageAccess(client, reader, itemId, "write");
        return insertPageMarkdown(client, itemId, input);
      });
    },

    async replacePageMarkdown(itemId: string, input: ReplacePageMarkdownInput) {
      return withTransaction(pool, (client) => replacePageMarkdown(client, itemId, input));
    },

    /**
     * Access is checked in the lookup transaction, before the replay in its own snapshot transaction, so a revoke
     * committing between the two is not seen by the replay.
     */
    async listPageChanges(
      itemId: string,
      options: ListPageChangesOptions,
      reader?: DatabaseReader,
    ): Promise<PageChange[]> {
      const doc = await withTransaction(pool, async (client) => {
        const [item] = await getItemsByIds(client, [itemId]);
        if (!item) throw new NotFoundError("Item not found", { resource: "item", itemId });
        await assertAgentPageAccess(client, reader, itemId, "read");
        return docsStore.getDocByItemId(client, itemId);
      });
      if (!doc) {
        if (options.since.getTime() > Date.now()) {
          throw new ValidationError("'since' must not be in the future", { field: "since" });
        }
        return [];
      }
      return listPageChanges(pool, doc.id, options);
    },

    async ensurePage(itemId: string, reader?: DatabaseReader): Promise<{ docId: string }> {
      return withTransaction(pool, async (client) => {
        const [visible] = await getItemsByIds(client, [itemId]);
        if (!visible) throw new NotFoundError("Item not found", { resource: "item", itemId });
        await assertAgentPageAccess(client, reader, itemId, "write");
        const item = await lockItemById(client, visible.databaseId, itemId);
        if (!item || item.deletedAt) throw new NotFoundError("Item not found", { resource: "item", itemId });
        const doc = await docsStore.getOrCreateDoc(client, itemId, "page");
        return { docId: doc.id };
      });
    },

    async createSubpage(
      input: PageCreateSubpageInput,
      origin: CreatedBy,
      reader?: DatabaseReader,
    ): Promise<PageCreateSubpageOutput> {
      return withTransaction(pool, (client) => createSubpageWithClient(client, input, origin, reader));
    },

    async duplicatePage(
      pageItemId: string,
      options: DuplicatePageOptions,
      reader?: DatabaseReader,
    ): Promise<PageDuplicateOutput> {
      return withTransaction(pool, async (client) => {
        await assertAgentPageAccess(client, reader, pageItemId, "write");
        return duplicatePageWithClient(client, pageItemId, options);
      });
    },

    async renamePage(input: PageRenameInput, origin: CreatedBy, reader?: DatabaseReader): Promise<PageRenameOutput> {
      return withTransaction(pool, async (client) => {
        await assertAgentPageAccess(client, reader, input.pageItemId, "write");
        return renamePageWithClient(client, input, origin);
      });
    },

    async convertPageToBlock(
      input: PageConvertToBlockInput,
      options: ConvertPageToBlockOptions,
    ): Promise<PageConvertToBlockOutput> {
      return withTransaction(pool, (client) => convertPageToBlockWithClient(client, input, options));
    },

    // ---- page content (blocks) ----
    async putBlock(itemId: string, block: BlockInput, origin: CreatedBy): Promise<void> {
      const doc = await withTransaction(pool, (client) => docsStore.getOrCreateDoc(client, itemId, "page"));
      await mutateDoc(pool, doc.id, origin, (ydoc) => blocks.putBlock(ydoc, block));
    },

    async getBlock(itemId: string, blockId: string): Promise<BlockData | null> {
      const docRow = await withTransaction(pool, (client) => docsStore.getDocByItemId(client, itemId));
      if (!docRow) return null;
      assertKind(docRow, "page");
      const doc = await loadDoc(pool, docRow.id);
      return blocks.getBlock(doc, blockId);
    },

    async listBlocks(itemId: string): Promise<BlockData[]> {
      const docRow = await withTransaction(pool, (client) => docsStore.getDocByItemId(client, itemId));
      if (!docRow) return [];
      assertKind(docRow, "page");
      const doc = await loadDoc(pool, docRow.id);
      return blocks.listBlocks(doc);
    },

    async deleteBlock(itemId: string, blockId: string, origin: CreatedBy): Promise<void> {
      const docRow = await withTransaction(pool, (client) => docsStore.getDocByItemId(client, itemId));
      if (!docRow) return;
      assertKind(docRow, "page");
      await mutateDoc(pool, docRow.id, origin, (ydoc) => blocks.deleteBlock(ydoc, blockId));
    },

    // ---- canvas elements ----
    async putCanvasElement(itemId: string, element: CanvasElementInput, origin: CreatedBy): Promise<void> {
      const doc = await withTransaction(pool, (client) => docsStore.getOrCreateDoc(client, itemId, "canvas"));
      await mutateDoc(pool, doc.id, origin, (ydoc) => canvas.putCanvasElement(ydoc, element));
    },

    async getCanvasElement(itemId: string, elementId: string): Promise<CanvasElementData | null> {
      const docRow = await withTransaction(pool, (client) => docsStore.getDocByItemId(client, itemId));
      if (!docRow) return null;
      assertKind(docRow, "canvas");
      const doc = await loadDoc(pool, docRow.id);
      return canvas.getCanvasElement(doc, elementId);
    },

    async listCanvasElements(itemId: string): Promise<CanvasElementData[]> {
      const docRow = await withTransaction(pool, (client) => docsStore.getDocByItemId(client, itemId));
      if (!docRow) return [];
      assertKind(docRow, "canvas");
      const doc = await loadDoc(pool, docRow.id);
      return canvas.listCanvasElements(doc);
    },

    async deleteCanvasElement(itemId: string, elementId: string, origin: CreatedBy): Promise<void> {
      const docRow = await withTransaction(pool, (client) => docsStore.getDocByItemId(client, itemId));
      if (!docRow) return;
      assertKind(docRow, "canvas");
      await mutateDoc(pool, docRow.id, origin, (ydoc) => canvas.deleteCanvasElement(ydoc, elementId));
    },

    // ---- version history ----
    async openVersionAt(itemId: string, at: Date): Promise<DocVersion | null> {
      const docRow = await withTransaction(pool, (client) => docsStore.getDocByItemId(client, itemId));
      if (!docRow) return null;
      const doc = await openDocVersionAt(pool, docRow.id, at);
      if (docRow.kind === "page") return { kind: "page", blocks: blocks.listBlocks(doc) };
      return { kind: "canvas", elements: canvas.listCanvasElements(doc) };
    },

    async restoreVersion(itemId: string, at: Date, reader?: DatabaseReader): Promise<PageRestoreOutput> {
      return withTransaction(pool, async (client) => {
        await assertAgentPageAccess(client, reader, itemId, "write");
        return restorePageVersionWithClient(client, itemId, at);
      });
    },
  };
}

export type DocStore = ReturnType<typeof createDocStore>;
