import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import * as Y from "yjs";
import {
  BlockInputError,
  BlockOperationError,
  deleteBlocks,
  insertBlocks,
  isBlockType,
  MAX_INDENT,
  parseMarkdown,
  readPageBlocks,
  serializeBlocks,
  validateBlockInput,
  type BlockIssue,
  type NewBlockInput,
  type ParsedBlock,
} from "@semprec/block-model";
import type { PageInsertInput } from "@semprec/shared";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { ConflictError, ValidationError } from "../errors.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import type { CreatedBy, ItemRow } from "../types.js";
import { assertItemLinksExist } from "./assertItemLinksExist.js";
import { loadDocWithClient, mutateDocWithClient } from "./docPersistence.js";
import { getDocByItemId, getOrCreateDoc } from "./docsStore.js";
import { lockLiveItem } from "./lockLiveItem.js";
import { readerOfWriter } from "../agentGrants/agentDatabaseAccess.js";
import { assertAgentPageAccess } from "./pageOwnerDatabase.js";
import { planBlockDiff, type BlockDiff } from "./pageBlockDiff.js";
import { renamePageWithClient } from "./pageOperations.js";
import { lockLiveChildPageIds, repointTrashedPagePositions } from "./pageTrash.js";
import { normalizePageTitle } from "./pageTitle.js";
import { PAGES_MODULE_ID } from "./pagesDatabase.js";

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

/** The refusal of an item whose document is not a page (a canvas): it cannot host one. */
function notAPageHost(): ValidationError {
  return new ValidationError("This item cannot host a page", { field: "itemId", reason: "not_a_page_host" });
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
  if (row && row.kind !== "page") throw notAPageHost();
  const doc = row ? await loadDocWithClient(client, row.id) : new Y.Doc();
  try {
    const blocks = readPageBlocks(doc);
    return {
      docId: row?.id ?? null,
      // Each page block keeps its own caption: two blocks may name one page id with different text.
      markdown: serializeBlocks(blocks, {
        resolvePageTitle: (_pageId, block) => (block.text ?? []).map((run) => run.insert).join(""),
      }),
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

/**
 * The refusal of Markdown that is not a valid list of blocks. Its details are a flat record, the only shape the REST
 * error contract serves (`publicErrorDetails` drops a nested `issues` array): `field` names the request field and
 * `path` and `reason` the first offending line or block and why, never any of the Markdown itself.
 */
function invalidMarkdown(issues: readonly BlockIssue[]): ValidationError {
  const first = issues[0];
  return new ValidationError("Invalid Markdown", {
    field: "markdown",
    ...(first === undefined ? {} : { path: first.path, reason: first.code }),
  });
}

/**
 * The ids the new blocks get: the caller's, one per parsed block (every element of the flat parser output,
 * indented list items included), or generated ones. The ids a `semprec:block`
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

/** Checks every parsed block against the block registry and returns it as an insertable block with its id, one `ids` entry per block. */
export function identifyBlocks(parsed: readonly ParsedBlock[], ids: readonly string[]): IdentifiedBlock[] {
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

/** A block ready to insert, whose id is always set. */
export type IdentifiedBlock = NewBlockInput & { id: string };

/**
 * The blocks `markdown` parses to (issue #1679): page links refused unless `options.allowPage` is set (#1765, which
 * validates them itself), every block checked against the block registry
 * and every `semprec://items/` link against the tenant (`assertItemLinksExist`, which must hold on the caller's
 * tenant-scoped write client). Reads only; nothing is written and no block has an id yet.
 */
export async function parseCheckedMarkdown(
  client: PoolClient,
  markdown: string,
  options: { allowPage?: boolean } = {},
): Promise<ParsedBlock[]> {
  let parsed: ParsedBlock[];
  try {
    parsed = parseMarkdown(markdown, { allowPage: options.allowPage ?? false });
  } catch (error) {
    if (error instanceof BlockInputError) throw invalidMarkdown(error.issues);
    throw error;
  }
  try {
    await assertItemLinksExist(client, parsed, "markdown");
  } catch (error) {
    // The guard's nested `issues` are not served over REST; every failed link answers one flat `{ field }` body.
    if (error instanceof ValidationError) throw new ValidationError(error.message, { field: "markdown" });
    throw error;
  }
  return parsed;
}

/** `parseCheckedMarkdown` plus an id for each block, from `blockIds` or generated, checked and ready to insert. */
export async function prepareMarkdownBlocks(
  client: PoolClient,
  markdown: string,
  blockIds?: readonly string[],
): Promise<IdentifiedBlock[]> {
  const parsed = await parseCheckedMarkdown(client, markdown);
  return identifyBlocks(parsed, resolveBlockIds(parsed.length, blockIds));
}

/** Where, and which blocks: what a caller decides inside the document write, from the document as it stands. */
export interface PageBlockPlan {
  /** The block to insert after, or `null` for the start of the page. */
  afterId: string | null;
  blocks: IdentifiedBlock[];
}

/** The refusal of a placement whose `afterBlockId` is not a block of the page. */
function unknownAfterBlock(): ValidationError {
  return new ValidationError("afterBlockId does not name a block of the page", { field: "placement.afterBlockId" });
}

/**
 * Inserts the blocks `plan` returns into the page of the live, locked item `host` as one document update authored
 * `origin`, creating the document when the item has none. `plan` runs inside the write on the loaded document, so the
 * position it picks is the one the blocks are inserted at: an unknown `afterId` is a `ValidationError` on
 * `placement.afterBlockId` and an id already in the page a `ConflictError` on `blockIds`; the caller's transaction rolls
 * a lazily created document back with either. `plan` may throw its own error, which propagates unchanged.
 */
export async function insertPlannedBlocks(
  client: PoolClient,
  host: ItemRow,
  origin: CreatedBy,
  plan: (doc: Y.Doc) => PageBlockPlan,
): Promise<string[]> {
  const row = await getOrCreateDoc(client, host.id, "page");
  return mutateDocWithClient(client, row.id, origin, (ydoc) => {
    const { afterId, blocks } = plan(ydoc);
    try {
      return insertBlocks(ydoc, afterId, blocks);
    } catch (error) {
      if (error instanceof BlockOperationError && error.code === "invalid_after_id") throw unknownAfterBlock();
      if (error instanceof BlockOperationError && error.code === "duplicate_block_id") {
        throw new ConflictError("A block id in blockIds is already in the page", { field: "blockIds" });
      }
      throw error;
    }
  });
}

/**
 * Inserts the blocks parsed from `input.markdown` into the page of `itemId` (issue #1679), at the start, at the end or
 * directly after `placement.afterBlockId`, as one document update authored `input.origin`. Page links are refused: a
 * link to a subpage is validated against the host's subpages, which `replacePageMarkdown` (#1765) does.
 * Everything that can refuse the Markdown runs before the document is created or written: the item is resolved live
 * and locked, then the blocks are prepared (`prepareMarkdownBlocks`). An unknown `afterBlockId` or an id already in the
 * document is refused inside the write. Markdown with no block writes nothing and creates no document, but an
 * `afterBlockId` it names is still checked against the page as it stands. After a block the new blocks are anchored
 * at that block's nesting level: each keeps its parsed indentation relative to the anchor, and a result past
 * `MAX_INDENT` is refused (nothing is clamped or dropped). `start` and `end` keep the parsed indentation.
 */
export async function insertPageMarkdown(
  client: PoolClient,
  itemId: string,
  input: InsertPageMarkdownInput,
): Promise<{ blockIds: string[] }> {
  const host = await lockLiveItem(client, itemId);
  const blocks = await prepareMarkdownBlocks(client, input.markdown, input.blockIds);
  const { placement } = input;
  if (blocks.length === 0) {
    if (typeof placement === "object") await assertAfterBlockExists(client, host.id, placement.afterBlockId);
    return { blockIds: [] };
  }
  const blockIds = await insertPlannedBlocks(client, host, input.origin, (ydoc) => {
    if (placement === "start") return { blocks, afterId: null };
    const current = readPageBlocks(ydoc).filter((block) => !block.synthetic && block.id !== null);
    if (placement === "end") return { blocks, afterId: current.at(-1)?.id ?? null };
    const target = current.find((block) => block.id === placement.afterBlockId);
    // An unknown target is refused by the insertion itself, with the same error as the empty-input check.
    return {
      afterId: placement.afterBlockId,
      blocks: target === undefined ? blocks : anchorIndent(blocks, target.indent),
    };
  });
  return { blockIds };
}

/** The blocks with `anchor` added to their indentation; past `MAX_INDENT` is an invalid-Markdown refusal. */
function anchorIndent(blocks: readonly IdentifiedBlock[], anchor: number): IdentifiedBlock[] {
  return blocks.map((block, index) => {
    const indent = anchor + (block.indent ?? 0);
    if (indent > MAX_INDENT) {
      throw new ValidationError("Invalid Markdown", {
        field: "markdown",
        path: `block ${index + 1}: indent`,
        reason: "invalid_indent",
      });
    }
    return { ...block, indent };
  });
}

/** Refuses an `afterBlockId` that is not a block of the page; reads the document without creating one. */
async function assertAfterBlockExists(client: PoolClient, itemId: string, afterBlockId: string): Promise<void> {
  const row = await getDocByItemId(client, itemId);
  if (row?.kind !== "page") throw unknownAfterBlock();
  const doc = await loadDocWithClient(client, row.id);
  try {
    const known = readPageBlocks(doc).some((block) => !block.synthetic && block.id === afterBlockId);
    if (!known) throw unknownAfterBlock();
  } finally {
    doc.destroy();
  }
}

/** A line `parseMarkdown` reads as a page link: the trimmed line is a link whose destination is `semprec://page/<id>`. */
const PAGE_LINK_LINE = /^\[(?:\\.|[^\]\\])*\]\(semprec:\/\/page\/[^)\s]+\)$/;

/** The refusal of a request whose `If-Match` is not the page's current version; it carries the version that is. */
export class PageVersionConflictError extends ConflictError {
  /** The version token (`docEtag`) the page has now, which the REST route sends back as the `ETag` header. */
  readonly currentEtag: string;

  constructor(currentEtag: string) {
    super("The page changed since the version the request names", { reason: "etag_mismatch" });
    this.name = "PageVersionConflictError";
    this.currentEtag = currentEtag;
  }
}

export interface ReplacePageMarkdownInput {
  markdown: string;
  /** The version token the caller read (`readPageMarkdown`); the replace is refused unless the page still has it. */
  expectedEtag: string;
  /** Who writes the document updates: derived server-side from the caller, never from a request body. */
  origin: CreatedBy;
  /** Who trashes the subpages whose links vanished, passed to the choke point's trash and its hooks. */
  writer: WriterIdentity;
  /** The user the trashed subpages are deleted for, passed to the choke point's trash; absent when no user is acting. */
  actingUserId?: string | undefined;
}

export interface ReplacePageMarkdownResult {
  /** The version token of the page after the replace. */
  etag: string;
  /** The subpages this call sent to the trash, each with the title its link carried. */
  trashedPages: Array<{ pageItemId: string; title: string }>;
}

/** The refusal of a page link block of a replacement body, for the block at `index`: `field` is the block field at fault. */
function pageLinkRefused(index: number, field: "pageId" | "text", reason: string): ValidationError {
  return new ValidationError("Invalid Markdown", { field: "markdown", path: `block ${index + 1}: ${field}`, reason });
}

/** Refuses a `page` block of a replacement body that names anything but a live subpage of the host, `ValidationError` on `markdown`. */
function assertPageLinksNameSubpages(
  blocks: ReadonlyArray<{ type: string; pageId?: string | null }>,
  liveSubpageIds: ReadonlySet<string>,
): void {
  for (const [index, block] of blocks.entries()) {
    if (block.type !== "page") continue;
    if (!liveSubpageIds.has(block.pageId ?? "")) throw pageLinkRefused(index, "pageId", "page_link_invalid");
  }
}

/**
 * The plain-text caption of each block of `markdown`, in block order, for the page link blocks: `parseMarkdown` reads a
 * page link as a block that carries only its page id, so this parses the Markdown a second time with every page link
 * line rewritten (by the test the parser applies itself: the trimmed line) to an ordinary link, which keeps its label as
 * text. Both parses split the same lines into the same blocks, so block `i` of one is block `i` of the other.
 */
function captionsOf(markdown: string): string[] {
  const rewritten = markdown
    .split("\n")
    .map((raw) => {
      const line = raw.replace(/\r$/, "").trim();
      return PAGE_LINK_LINE.test(line)
        ? line.replace(/\(semprec:\/\/page\/[^)\s]+\)$/, "(https://example.invalid)")
        : raw;
    })
    .join("\n");
  return parseMarkdown(rewritten).map((block) => (block.text ?? []).map((run) => run.insert).join(""));
}

/**
 * The blocks `markdown` parses to for a replace, each with a fresh id: checked like an insert (`parseCheckedMarkdown`,
 * page links allowed, so the item links are checked against the tenant) and every block against the block registry. A
 * `page` block names its page in lower case and carries its normalized caption as its text; a caption over the title
 * limit is refused here, before anything is written. Whether a page link names a subpage is decided by the caller.
 */
async function prepareReplacementBlocks(client: PoolClient, markdown: string): Promise<IdentifiedBlock[]> {
  const parsed = await parseCheckedMarkdown(client, markdown, { allowPage: true });
  const identified = identifyBlocks(parsed, resolveBlockIds(parsed.length, undefined));
  if (!identified.some((block) => block.type === "page")) return identified;
  const captions = captionsOf(markdown);
  return identified.map((block, index) => {
    if (block.type !== "page" || block.pageId === undefined) return block;
    try {
      return { ...block, pageId: block.pageId.toLowerCase(), text: normalizePageTitle(captions[index] ?? "") };
    } catch (error) {
      if (error instanceof ValidationError) throw pageLinkRefused(index, "text", "page_title_too_long");
      throw error;
    }
  });
}

/** The plain text of a block, as the Markdown read writes it into a link caption. */
function plainTextOf(runs: ReadonlyArray<{ insert: string }>): string {
  return runs.map((run) => run.insert).join("");
}

/** The caption of a page link block `prepareReplacementBlocks` prepared; its text is always the normalized caption. */
function captionOf(block: IdentifiedBlock | undefined): string {
  return typeof block?.text === "string" ? block.text : "";
}

/** For each page that a `page` block of `blocks` names, in lower case, the index of the first block that names it. */
function firstBlockIndexByPage(blocks: ReadonlyArray<{ type: string; pageId?: string | null }>): Map<string, number> {
  const byPage = new Map<string, number>();
  for (const [index, block] of blocks.entries()) {
    const pageId = block.type === "page" ? block.pageId?.toLowerCase() : undefined;
    if (pageId !== undefined && !byPage.has(pageId)) byPage.set(pageId, index);
  }
  return byPage;
}

/** The version token of the page document of `itemId`; that of an empty document when the item has none. */
async function etagOfItemPage(client: PoolClient, itemId: string): Promise<string> {
  const row = await getDocByItemId(client, itemId);
  const doc = row ? await loadDocWithClient(client, row.id) : new Y.Doc();
  try {
    return docEtag(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * Applies a planned diff in the document write it runs in: every insertion first, so the deletion never empties the
 * page, then the recorded positions of trashed subpages are moved off the blocks the deletion removed.
 */
function applyBlockDiff(doc: Y.Doc, diff: BlockDiff): void {
  for (const { afterId, blocks } of diff.insertions) insertBlocks(doc, afterId, blocks);
  deleteBlocks(doc, diff.deleteIds);
  // A subpage trashed earlier (by this request or before it) is restored after the block that stood before its link;
  // when this diff deletes that block, the recorded neighbor moves to the block that took its place.
  repointTrashedPagePositions(doc, diff.placeAfter);
}

/** The real blocks of `ydoc` in document order. */
function realBlocks(ydoc: Y.Doc) {
  return readPageBlocks(ydoc).filter((block) => !block.synthetic && block.id !== null);
}

/**
 * Replaces the whole body of the page of `itemId` with `input.markdown` (issue #1765) when the page still has the
 * version `input.expectedEtag`, in the caller's transaction. Nothing is written, and no document is created, when
 * anything below refuses.
 *
 * For a writer `readerOfWriter` names a reader for (an agent under a run or an approved request replayed for one: its
 * project; an external client on `/mcp`, issue #1998) the reader needs write access to the database that owns the
 * page (`assertAgentPageAccess`), checked first.
 *
 * The item is resolved live and its row locked (a foreign or unknown id is the one `NotFoundError`), then the
 * Markdown is parsed and checked (`prepareReplacementBlocks`, so an invalid block or item link is a `ValidationError`
 * on `markdown`). A `page` block must name a live subpage of this item (a Pages item whose `parentItemId` is the item);
 * any other id, a trashed subpage and another parent's page are the same `ValidationError`. The rows of all live
 * subpages are locked, in id order, before the document is loaded: a direct trash of a subpage locks its row and then
 * this document, so taking the document first would let the two wait for each other. The document is then loaded under
 * its row locks and its `docEtag` compared with `expectedEtag`; a different one is a `PageVersionConflictError` that
 * carries the current token. Two replaces of the same item cannot interleave, because the second waits on the item's
 * row and then fails the comparison. An item without a document has nothing to lock, so a document another
 * transaction creates and commits before step 3 writes is found by that step (`getOrCreateDoc` returns it) and its
 * token is compared with `expectedEtag` again, on the document under its row locks, before anything is written to it.
 *
 * Then, in this order and all in this transaction:
 * 1. a subpage the page links now but the new Markdown no longer links is sent to the trash through the choke point
 *    (`itemDeleteWithClient`, whose Pages hook removes the first block naming it and records where it stood, so
 *    restoring the page puts the block back there). A subpage named by no block is left alone;
 * 2. a subpage whose first link has a different caption than the new Markdown gives is renamed (`renamePageWithClient`,
 *    which writes the item's title and the block's text);
 * 3. the document is brought to the new Markdown in one document update (`planBlockDiff`): a block with unchanged
 *    content keeps its id and is not rewritten, every other new block is inserted with a fresh id, and a block that
 *    no new block pairs with is deleted; the position recorded for a trashed subpage, whose neighbor block this
 *    deletes, is moved to the block that took the neighbor's place (`placeAfter`), so restoring the subpage puts its
 *    block back where it stood. Markdown identical to the page writes nothing, and empty Markdown for an item
 *    without a document creates none.
 *
 * Any error rolls everything back with the caller's transaction. Returns the new version token and the pages step 1
 * sent to the trash.
 */
export async function replacePageMarkdown(
  client: PoolClient,
  itemId: string,
  input: ReplacePageMarkdownInput,
): Promise<ReplacePageMarkdownResult> {
  await assertAgentPageAccess(client, readerOfWriter(input.writer), itemId, "write");
  const host = await lockLiveItem(client, itemId);
  const blocks = await prepareReplacementBlocks(client, input.markdown);

  const pagesDatabase = await getDatabaseByModuleId(client, PAGES_MODULE_ID);
  const liveSubpageIds = new Set(pagesDatabase ? await lockLiveChildPageIds(client, pagesDatabase.id, host.id) : []);
  assertPageLinksNameSubpages(blocks, liveSubpageIds);

  const docRow = await getDocByItemId(client, host.id);
  if (docRow && docRow.kind !== "page") throw notAPageHost();
  const loaded = docRow ? await loadDocWithClient(client, docRow.id) : new Y.Doc();
  let current: ReturnType<typeof realBlocks>;
  try {
    const currentEtag = docEtag(loaded);
    if (currentEtag !== input.expectedEtag) throw new PageVersionConflictError(currentEtag);
    current = realBlocks(loaded);
  } finally {
    loaded.destroy();
  }

  const linkedNow = firstBlockIndexByPage(current);
  const linkedNext = firstBlockIndexByPage(blocks);

  const trashedPages: ReplacePageMarkdownResult["trashedPages"] = [];
  for (const [pageItemId, index] of linkedNow) {
    if (pagesDatabase === null || !liveSubpageIds.has(pageItemId) || linkedNext.has(pageItemId)) continue;
    const trashed = await itemDeleteWithClient(client, pagesDatabase.id, pageItemId, {
      queueAffinity: createActionQueueAffinity(),
      actingUserId: input.actingUserId,
      writer: input.writer,
    });
    // The row has been locked since `lockLiveChildPageIds`, so the trash finds it; a missing row would mean the lock was not held.
    if (!trashed) throw new Error(`Subpage ${pageItemId} disappeared during the replace of page ${host.id}`);
    const caption = plainTextOf(current[index]?.text ?? []);
    const storedTitle: unknown = trashed.properties.title;
    trashedPages.push({
      pageItemId,
      title: caption !== "" ? caption : typeof storedTitle === "string" ? storedTitle : "",
    });
  }

  for (const [pageItemId, nextIndex] of linkedNext) {
    const currentIndex = linkedNow.get(pageItemId);
    const title = captionOf(blocks[nextIndex]);
    if (currentIndex !== undefined && plainTextOf(current[currentIndex]?.text ?? []) !== title) {
      await renamePageWithClient(client, { pageItemId, title }, input.origin);
    }
  }

  const writeRow = docRow ?? (blocks.length > 0 ? await getOrCreateDoc(client, host.id, "page") : null);
  if (writeRow) {
    await mutateDocWithClient(client, writeRow.id, input.origin, (ydoc) => {
      if (docRow === null) {
        // The absence of a document locks nothing, so a document another transaction created and committed since the
        // comparison above is only visible here, loaded under its row locks. Nothing of this request has written to a
        // document that did not exist, so the token it started from must still be the token of what is written over.
        const lockedEtag = docEtag(ydoc);
        if (lockedEtag !== input.expectedEtag) throw new PageVersionConflictError(lockedEtag);
      }
      applyBlockDiff(ydoc, planBlockDiff(realBlocks(ydoc), blocks));
    });
  }
  return { etag: await etagOfItemPage(client, host.id), trashedPages };
}

export interface PageReplaceCheckResult {
  /** The item's page document, or `null` when it has none. */
  docId: string | null;
  /** The version token of the page, equal to the `expectedEtag` the check was given. */
  etag: string;
}

/**
 * The read-only counterpart of the refusals at the head of `replacePageMarkdown`, for the approval of a replace
 * (`pageReplaceApproval.ts`): the item is resolved live and its row locked, the Markdown is parsed and checked
 * (`prepareReplacementBlocks`), every `page` block must name a live subpage of the item, and the page must still have
 * the version `expectedEtag` (`PageVersionConflictError`, which carries the current token). It writes nothing and locks
 * no subpage and no document, so it takes no lock in another order than `replacePageMarkdown`; the replace that
 * follows in the same transaction takes them and compares the token again.
 */
export async function checkPageReplace(
  client: PoolClient,
  itemId: string,
  markdown: string,
  expectedEtag: string,
): Promise<PageReplaceCheckResult> {
  const host = await lockLiveItem(client, itemId);
  const blocks = await prepareReplacementBlocks(client, markdown);
  const pagesDatabase = await getDatabaseByModuleId(client, PAGES_MODULE_ID);
  const { rows } = pagesDatabase
    ? await client.query<{ id: string }>(
        `SELECT id FROM items WHERE database_id = $1 AND properties->>'parentItemId' = $2 AND deleted_at IS NULL`,
        [pagesDatabase.id, host.id],
      )
    : { rows: [] };
  assertPageLinksNameSubpages(blocks, new Set(rows.map((row) => row.id)));
  const docRow = await getDocByItemId(client, host.id);
  if (docRow && docRow.kind !== "page") throw notAPageHost();
  const etag = await etagOfItemPage(client, host.id);
  if (etag !== expectedEtag) throw new PageVersionConflictError(etag);
  return { docId: docRow?.id ?? null, etag };
}
