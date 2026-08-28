import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import type { CreatedBy, DocKind, DocRow } from "../types.js";
import * as docsStore from "./docsStore.js";
import { loadDoc, mutateDoc } from "./docPersistence.js";
import * as blocks from "./blocks.js";
import type { BlockInput, BlockData } from "./blocks.js";
import * as canvas from "./canvas.js";
import type { CanvasElementInput, CanvasElementData } from "./canvas.js";
import { openDocVersionAt, squashDocHistory } from "./docHistory.js";

function assertKind(doc: DocRow, expected: DocKind): void {
  if (doc.kind !== expected) {
    throw new ValidationError(`Doc for item ${doc.itemId} is '${doc.kind}', not '${expected}'`, { itemId: doc.itemId, kind: doc.kind });
  }
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
    async squashHistory(itemId: string, createdBy: CreatedBy, retentionMs?: number): Promise<void> {
      const docRow = await withTransaction(pool, (client) => docsStore.getDocByItemId(client, itemId));
      if (!docRow) return;
      await squashDocHistory(pool, docRow.id, createdBy, retentionMs);
    },

    async openVersionAt(itemId: string, at: Date): Promise<DocVersion | null> {
      const docRow = await withTransaction(pool, (client) => docsStore.getDocByItemId(client, itemId));
      if (!docRow) return null;
      const doc = await openDocVersionAt(pool, docRow.id, at);
      if (docRow.kind === "page") return { kind: "page", blocks: blocks.listBlocks(doc) };
      return { kind: "canvas", elements: canvas.listCanvasElements(doc) };
    },
  };
}

export type DocStore = ReturnType<typeof createDocStore>;
