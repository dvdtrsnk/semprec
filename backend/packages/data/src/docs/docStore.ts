import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { getItemsByIds, lockItemById } from "../chokePoint/itemsStore.js";
import type {
  PageCreateSubpageInput,
  PageCreateSubpageOutput,
  PageDuplicateOutput,
  PageRenameInput,
  PageRenameOutput,
  PageRestoreOutput,
} from "@semprec/shared";
import type { CreatedBy, DocKind, DocRow } from "../types.js";
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
  createSubpageWithClient,
  duplicatePageWithClient,
  renamePageWithClient,
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
import { assertAgentPageAccess } from "./pageOwnerDatabase.js";

function assertKind(doc: DocRow, expected: DocKind): void {
  if (doc.kind !== expected) {
    throw new ValidationError(`Doc for item ${doc.itemId} is '${doc.kind}', not '${expected}'`, {
      itemId: doc.itemId,
      kind: doc.kind,
    });
  }
}

/**
 * The client-scoped counterpart to `createDocStore(pool).putBlock` below, for a caller
 * that needs the block append to commit atomically with its own structured-data write
 * (issue #105's proposal confirm: the block append and the Processing proposal's
 * `confirmed` lock must both land, or neither does).
 */
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

export interface DocVersion {
  kind: DocKind;
  blocks?: BlockData[];
  elements?: CanvasElementData[];
}

/**
 * The doc/CRDT store: a separate, independent mechanism from the structured-data
 * choke-point (issue #23, point 1 — two parallel persistence-and-merge mechanisms by
 * deliberate design, not unified into one consistency model). Every write here goes
 * through this factory, mirroring the choke-point's single-writer discipline for its
 * own tables.
 *
 * The `origin: CreatedBy` accepted by every write below (including `"ai_agent"`) is an
 * explicit, issue-scoped exception to the state-writes skill's "agent code never
 * writes state directly, only proposes" rule — the same class of exception that rule
 * already carves out for "the issue that introduces the choke-point itself". Issue
 * #23, point 4, steps 3-5 explicitly designs a direct agent write path (load doc,
 * `doc.transact(fn, 'ai_agent')`, persist the resulting update), with `created_by`
 * attribution as the audit mechanism in place of an approval-queue/`confirm` flow that
 * doesn't exist yet in this codebase (agent-runtime is still an empty stub). Once an
 * approval queue exists for CRDT docs, agent-originated writes should route through it
 * like everything else; until then, this is the sanctioned mechanism.
 */
export function createDocStore(pool: Pool) {
  return {
    async getOrCreateDoc(itemId: string, kind: DocKind): Promise<DocRow> {
      return withTransaction(pool, (client) => docsStore.getOrCreateDoc(client, itemId, kind));
    },

    async getDoc(itemId: string): Promise<DocRow | null> {
      return withTransaction(pool, (client) => docsStore.getDocByItemId(client, itemId));
    },

    /**
     * The summary of a page. For an agent (`agentProjectItemId`) its project needs read access to the database that
     * owns the page, checked first in the read's own transaction (`assertAgentPageAccess`); the same holds for every
     * method of this store that takes the parameter.
     */
    async getPageSummary(itemId: string, locale: string, limit?: number, agentProjectItemId?: string) {
      return withTransaction(pool, async (client) => {
        await assertAgentPageAccess(client, agentProjectItemId, itemId, "read");
        return readPageSummary(client, itemId, locale, limit);
      });
    },

    /** The page as canonical Markdown plus its version token (issue #1678); never creates a document. */
    async readPageMarkdown(itemId: string, agentProjectItemId?: string) {
      return withTransaction(pool, async (client) => {
        await assertAgentPageAccess(client, agentProjectItemId, itemId, "read");
        return readPageMarkdown(client, itemId);
      });
    },

    /** Inserts Markdown into a page (issue #1679) in one transaction; the caller supplies the write's origin. */
    async insertPageMarkdown(itemId: string, input: InsertPageMarkdownInput, agentProjectItemId?: string) {
      return withTransaction(pool, async (client) => {
        await assertAgentPageAccess(client, agentProjectItemId, itemId, "write");
        return insertPageMarkdown(client, itemId, input);
      });
    },

    /** Replaces a page's body from Markdown under the version token the caller read (issue #1765) in one transaction. */
    async replacePageMarkdown(itemId: string, input: ReplacePageMarkdownInput) {
      return withTransaction(pool, (client) => replacePageMarkdown(client, itemId, input));
    },

    /**
     * What was written to the page of `itemId` since `options.since` by `options.by` (issue #1680). The item is read in
     * the caller's tenant like any item read, so a foreign or unknown id is one `NotFoundError`; an item without a page
     * document has no changes (`[]`), and then only the future check applies since there is no history to bound `since`.
     * An agent's access is checked in this lookup transaction, before the history is replayed in its own snapshot
     * transaction (`listPageChanges`), so a revoke that commits between the two is not seen by that replay.
     */
    async listPageChanges(
      itemId: string,
      options: ListPageChangesOptions,
      agentProjectItemId?: string,
    ): Promise<PageChange[]> {
      const doc = await withTransaction(pool, async (client) => {
        const [item] = await getItemsByIds(client, [itemId]);
        if (!item) throw new NotFoundError("Item not found", { resource: "item", itemId });
        await assertAgentPageAccess(client, agentProjectItemId, itemId, "read");
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

    async ensurePage(itemId: string, agentProjectItemId?: string): Promise<{ docId: string }> {
      return withTransaction(pool, async (client) => {
        const [visible] = await getItemsByIds(client, [itemId]);
        if (!visible) throw new NotFoundError("Item not found", { resource: "item", itemId });
        await assertAgentPageAccess(client, agentProjectItemId, itemId, "write");
        const item = await lockItemById(client, visible.databaseId, itemId);
        if (!item || item.deletedAt) throw new NotFoundError("Item not found", { resource: "item", itemId });
        const doc = await docsStore.getOrCreateDoc(client, itemId, "page");
        return { docId: doc.id };
      });
    },

    /** Creates one subpage (issue #1676) in one transaction; `origin` is derived server-side from the caller. */
    async createSubpage(
      input: PageCreateSubpageInput,
      origin: CreatedBy,
      agentProjectItemId?: string,
    ): Promise<PageCreateSubpageOutput> {
      return withTransaction(pool, (client) => createSubpageWithClient(client, input, origin, agentProjectItemId));
    },

    /** Copies a subpage with every page nested in it (issue #1722) in one transaction; see `duplicatePageWithClient`. */
    async duplicatePage(
      pageItemId: string,
      options: DuplicatePageOptions,
      agentProjectItemId?: string,
    ): Promise<PageDuplicateOutput> {
      return withTransaction(pool, async (client) => {
        await assertAgentPageAccess(client, agentProjectItemId, pageItemId, "write");
        return duplicatePageWithClient(client, pageItemId, options);
      });
    },

    /** Renames a subpage (issue #1725) in one transaction; `origin` is derived server-side from the caller. */
    async renamePage(
      input: PageRenameInput,
      origin: CreatedBy,
      agentProjectItemId?: string,
    ): Promise<PageRenameOutput> {
      return withTransaction(pool, async (client) => {
        await assertAgentPageAccess(client, agentProjectItemId, input.pageItemId, "write");
        return renamePageWithClient(client, input, origin);
      });
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

    /** Restores the page of `itemId` to `at` as one `user` update (issue #1617); see `docPageRestore.ts`. */
    async restoreVersion(itemId: string, at: Date): Promise<PageRestoreOutput> {
      return withTransaction(pool, (client) => restorePageVersionWithClient(client, itemId, at));
    },
  };
}

export type DocStore = ReturnType<typeof createDocStore>;
