import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import * as Y from "yjs";
import {
  BlockInputError,
  BlockOperationError,
  insertBlocks,
  isBlockType,
  parseMarkdown,
  readPageBlocks,
  serializeBlocks,
  validateBlockInput,
  type BlockIssue,
  type NewBlockInput,
  type ParsedBlock,
} from "@semprec/block-model";
import type { PageInsertInput } from "@semprec/shared";
import { ConflictError, ValidationError } from "../errors.js";
import type { CreatedBy } from "../types.js";
import { assertItemLinksExist } from "./assertItemLinksExist.js";
import { loadDocWithClient, mutateDocWithClient } from "./docPersistence.js";
import { getDocByItemId, getOrCreateDoc } from "./docsStore.js";
import { lockLiveItem } from "./lockLiveItem.js";

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

export interface InsertPageMarkdownInput {
  placement: PageInsertInput["placement"];
  markdown: string;
  /** One id per parsed block, in order; absent means every id is generated. */
  blockIds?: string[] | undefined;
  /** Who writes: derived server-side from the caller, never from a request body. */
  origin: CreatedBy;
}

/** The refusal of Markdown that is not a valid list of blocks; `issues` name the offending lines and fields. */
function invalidMarkdown(issues: readonly BlockIssue[]): ValidationError {
  return new ValidationError("Invalid Markdown", { field: "markdown", issues });
}

/**
 * The ids the new blocks get: the caller's, one per parsed block, or generated ones. The ids a `semprec:block`
 * comment carries are never used, so a body cannot choose an id the caller did not name. A supplied list must match the
 * block count and hold no repeated or empty id (`ValidationError` on `blockIds`); an id already in the document is a
 * `ConflictError`, decided where the document is read.
 */
function resolveBlockIds(count: number, supplied: readonly string[] | undefined): string[] {
  if (supplied === undefined) return Array.from({ length: count }, () => randomUUID());
  if (supplied.length !== count) {
    throw new ValidationError(`blockIds names ${supplied.length} blocks but the Markdown has ${count}`, {
      field: "blockIds",
    });
  }
  if (new Set(supplied).size !== supplied.length) {
    throw new ValidationError("blockIds names a block twice", { field: "blockIds" });
  }
  return [...supplied];
}

/** Checks every parsed block against the block registry and returns it as an insertable block with its id. */
/** A block ready to insert, whose id is always set. */
type IdentifiedBlock = NewBlockInput & { id: string };

function toNewBlocks(parsed: readonly ParsedBlock[], ids: readonly string[]): IdentifiedBlock[] {
  const issues = parsed.flatMap((block, index) =>
    validateBlockInput({ ...block, id: ids[index] }).map((issue) => ({
      ...issue,
      path: `block ${index + 1}: ${issue.path}`,
    })),
  );
  if (issues.length > 0) throw invalidMarkdown(issues);
  return parsed.flatMap((block, index) => {
    const id = ids[index];
    if (id === undefined || !isBlockType(block.type)) return [];
    return [
      {
        id,
        type: block.type,
        indent: block.indent,
        ...(block.done === undefined ? {} : { done: block.done }),
        ...(block.text === undefined ? {} : { text: block.text }),
        ...(block.pageId === undefined ? {} : { pageId: block.pageId }),
      },
    ];
  });
}

/**
 * Inserts the blocks parsed from `input.markdown` into the page of `itemId` (issue #1679), at the start, at the end or
 * directly after `placement.afterBlockId`, in one `mutateDocWithClient` call and so as one document update authored
 * `input.origin`. Page links are refused: a link to a subpage is validated against the host's subpages, which only the
 * replace operation (#1765) does. Everything that can refuse the Markdown runs before the document is created or
 * written: the item is resolved live and locked, the Markdown is parsed and checked against the block registry, every
 * `semprec://items/` link must name a live item of the tenant (`assertItemLinksExist`), and the ids are resolved. An
 * unknown `afterBlockId` or an id already in the document is refused inside the write, and the caller's transaction
 * rolls back with it, lazy document creation included. Markdown with no block writes nothing and creates no document.
 * The flat block model has no nesting, so "after a block" means directly after it in document order.
 */
export async function insertPageMarkdown(
  client: PoolClient,
  itemId: string,
  input: InsertPageMarkdownInput,
): Promise<{ blockIds: string[] }> {
  await lockLiveItem(client, itemId);
  let parsed: ParsedBlock[];
  try {
    parsed = parseMarkdown(input.markdown, { allowPage: false });
  } catch (error) {
    if (error instanceof BlockInputError) throw invalidMarkdown(error.issues);
    throw error;
  }
  await assertItemLinksExist(client, parsed, "markdown");
  const ids = resolveBlockIds(parsed.length, input.blockIds);
  const blocks = toNewBlocks(parsed, ids);
  if (blocks.length === 0) return { blockIds: [] };

  const doc = await getOrCreateDoc(client, itemId, "page");
  await mutateDocWithClient(client, doc.id, input.origin, (ydoc) => {
    const { placement } = input;
    const afterId =
      placement === "start"
        ? null
        : placement === "end"
          ? (readPageBlocks(ydoc)
              .filter((block) => !block.synthetic && block.id !== null)
              .at(-1)?.id ?? null)
          : placement.afterBlockId;
    try {
      insertBlocks(ydoc, afterId, blocks);
    } catch (error) {
      if (error instanceof BlockOperationError && error.code === "invalid_after_id") {
        throw new ValidationError("afterBlockId does not name a block of the page", {
          field: "placement.afterBlockId",
        });
      }
      if (error instanceof BlockOperationError && error.code === "duplicate_block_id") {
        throw new ConflictError("A block id in blockIds is already in the page", { field: "blockIds" });
      }
      throw error;
    }
  });
  return { blockIds: blocks.map((block) => block.id) };
}
