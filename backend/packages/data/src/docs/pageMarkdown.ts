import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import * as Y from "yjs";
import { readPageBlocks, serializeBlocks } from "@semprec/block-model";
import { ValidationError } from "../errors.js";
import { loadDocWithClient } from "./docPersistence.js";
import { getDocByItemId } from "./docsStore.js";

/**
 * The version token of a page: `base64url(sha256(Y.encodeSnapshot(Y.snapshot(doc))))`. A Yjs snapshot is the state
 * vector plus the delete set, so a write that only deletes text changes it (the state vector alone does not change
 * on pure deletion), while compaction rewrites storage but not the logical document and leaves it unchanged.
 */
export function docEtag(doc: Y.Doc): string {
  return createHash("sha256")
    .update(Y.encodeSnapshot(Y.snapshot(doc)))
    .digest("base64url");
}

export interface PageMarkdownRead {
  /** The item's page document, or `null` when it has none (a read never creates one). */
  docId: string | null;
  /** The canonical Markdown of the page's blocks (#1608); the page title is not part of it. */
  markdown: string;
  etag: string;
}

/**
 * Reads the page of `itemId` as canonical Markdown and its version token (issue #1678). It finds the document with
 * `getDocByItemId` and never creates one: an item without a document reads as an empty body with the token of an
 * empty document, so the same token applies once a later write creates the document lazily. A `page` block is
 * written as a link whose caption is the block's own title text. An item that already holds a canvas document
 * cannot host a page (`ValidationError`).
 */
export async function readPageMarkdown(client: PoolClient, itemId: string): Promise<PageMarkdownRead> {
  const row = await getDocByItemId(client, itemId);
  if (row && row.kind !== "page") {
    throw new ValidationError("This item cannot host a page", { field: "itemId", reason: "not_a_page_host" });
  }
  const doc = row ? await loadDocWithClient(client, row.id) : new Y.Doc();
  try {
    const blocks = readPageBlocks(doc);
    const titles = new Map<string, string>();
    for (const block of blocks) {
      if (block.type === "page" && block.pageId !== null) {
        titles.set(block.pageId, block.text.map((run) => run.insert).join(""));
      }
    }
    return {
      docId: row?.id ?? null,
      markdown: serializeBlocks(blocks, { resolvePageTitle: (pageId) => titles.get(pageId) ?? "" }),
      etag: docEtag(doc),
    };
  } finally {
    doc.destroy();
  }
}
