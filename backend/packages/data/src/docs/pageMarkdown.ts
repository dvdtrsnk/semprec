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
 * Page version token. A Yjs snapshot includes the delete set, so a pure deletion changes it (the state vector alone
 * would not), while compaction leaves it unchanged.
 */
export function docEtag(doc: Y.Doc): string {
  return createHash("sha256")
    .update(Y.encodeSnapshot(Y.snapshot(doc)))
    .digest("base64url");
}

function notAPageHost(): ValidationError {
  return new ValidationError("This item cannot host a page", { field: "itemId", reason: "not_a_page_host" });
}

export interface PageMarkdownRead {
  /** `null` when the item has no document; a read never creates one. */
  docId: string | null;
  /** Excludes the page title. */
  markdown: string;
  etag: string;
}

/**
 * Never creates a document: an item without one reads as an empty body with the empty-document token, so the token
 * stays valid once a later write creates the document lazily.
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
  /** One id per parsed block; absent means generated. */
  blockIds?: string[] | undefined;
  /** Derived server-side from the caller, never from a request body. */
  origin: CreatedBy;
}

/**
 * Details stay flat because `publicErrorDetails` drops a nested `issues` array; they never echo the Markdown itself.
 */
function invalidMarkdown(issues: readonly BlockIssue[]): ValidationError {
  const first = issues[0];
  return new ValidationError("Invalid Markdown", {
    field: "markdown",
    ...(first === undefined ? {} : { path: first.path, reason: first.code }),
  });
}

/**
 * Ids carried by `semprec:block` comments are never used, so a body cannot choose an id the caller did not name. An id
 * already in the document is a `ConflictError`, decided where the document is read.
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

export type IdentifiedBlock = NewBlockInput & { id: string };

/**
 * Page links are refused unless `options.allowPage` is set (the caller then validates them). `client` must be the
 * caller's tenant-scoped write client so `semprec://items/` links are checked against the tenant. Read-only.
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
    // Nested `issues` are not served over REST; flatten to `{ field }`.
    if (error instanceof ValidationError) throw new ValidationError(error.message, { field: "markdown" });
    throw error;
  }
  return parsed;
}

export async function prepareMarkdownBlocks(
  client: PoolClient,
  markdown: string,
  blockIds?: readonly string[],
): Promise<IdentifiedBlock[]> {
  const parsed = await parseCheckedMarkdown(client, markdown);
  return identifyBlocks(parsed, resolveBlockIds(parsed.length, blockIds));
}

/** Decided inside the document write, from the document as it stands. */
export interface PageBlockPlan {
  /** `null` for the start of the page. */
  afterId: string | null;
  blocks: IdentifiedBlock[];
}

function unknownAfterBlock(): ValidationError {
  return new ValidationError("afterBlockId does not name a block of the page", { field: "placement.afterBlockId" });
}

/**
 * `host` must be live and locked. `plan` runs inside the write on the loaded document, so the position it picks is the
 * one used. The document is created lazily; the caller's transaction rolls it back on any error.
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
 * Page links are refused here; only `replacePageMarkdown` can validate them against the host's subpages. Everything
 * that can refuse the Markdown runs before the document is created. Empty Markdown creates no document but still
 * checks `afterBlockId`. After a block, new blocks are indented relative to it; past `MAX_INDENT` is refused, never
 * clamped.
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
    // An unknown target is refused by the insertion itself.
    return {
      afterId: placement.afterBlockId,
      blocks: target === undefined ? blocks : anchorIndent(blocks, target.indent),
    };
  });
  return { blockIds };
}

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

/** Must match how `parseMarkdown` recognizes a page link line (applied to the trimmed line). */
const PAGE_LINK_LINE = /^\[(?:\\.|[^\]\\])*\]\(semprec:\/\/page\/[^)\s]+\)$/;

export class PageVersionConflictError extends ConflictError {
  /** Sent back by the REST route as the `ETag` header. */
  readonly currentEtag: string;

  constructor(currentEtag: string) {
    super("The page changed since the version the request names", { reason: "etag_mismatch" });
    this.name = "PageVersionConflictError";
    this.currentEtag = currentEtag;
  }
}

export interface ReplacePageMarkdownInput {
  markdown: string;
  expectedEtag: string;
  /** Derived server-side from the caller, never from a request body. */
  origin: CreatedBy;
  writer: WriterIdentity;
  actingUserId?: string | undefined;
}

export interface ReplacePageMarkdownResult {
  etag: string;
  /** Each with the title its link carried. */
  trashedPages: Array<{ pageItemId: string; title: string }>;
}

function pageLinkRefused(index: number, field: "pageId" | "text", reason: string): ValidationError {
  return new ValidationError("Invalid Markdown", { field: "markdown", path: `block ${index + 1}: ${field}`, reason });
}

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
 * `parseMarkdown` drops a page link's caption, so this reparses with page links rewritten to ordinary links. Both
 * parses split the same lines into the same blocks, so block `i` of one is block `i` of the other.
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
 * Page ids are lowercased and captions normalized (too long is refused before any write). Whether a page link names a
 * subpage is decided by the caller.
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

function plainTextOf(runs: ReadonlyArray<{ insert: string }>): string {
  return runs.map((run) => run.insert).join("");
}

function captionOf(block: IdentifiedBlock | undefined): string {
  return typeof block?.text === "string" ? block.text : "";
}

/** Lowercased page id -> index of the first block naming it. */
function firstBlockIndexByPage(blocks: ReadonlyArray<{ type: string; pageId?: string | null }>): Map<string, number> {
  const byPage = new Map<string, number>();
  for (const [index, block] of blocks.entries()) {
    const pageId = block.type === "page" ? block.pageId?.toLowerCase() : undefined;
    if (pageId !== undefined && !byPage.has(pageId)) byPage.set(pageId, index);
  }
  return byPage;
}

async function etagOfItemPage(client: PoolClient, itemId: string): Promise<string> {
  const row = await getDocByItemId(client, itemId);
  const doc = row ? await loadDocWithClient(client, row.id) : new Y.Doc();
  try {
    return docEtag(doc);
  } finally {
    doc.destroy();
  }
}

/** Insertions first, so the deletion never empties the page. */
function applyBlockDiff(doc: Y.Doc, diff: BlockDiff): void {
  for (const { afterId, blocks } of diff.insertions) insertBlocks(doc, afterId, blocks);
  deleteBlocks(doc, diff.deleteIds);
  // Trashed subpages restore after their recorded neighbor; move that record off deleted blocks.
  repointTrashedPagePositions(doc, diff.placeAfter);
}

function realBlocks(ydoc: Y.Doc) {
  return readPageBlocks(ydoc).filter((block) => !block.synthetic && block.id !== null);
}

/**
 * Replaces the whole page body when it still has `expectedEtag`, in the caller's transaction; nothing is written when
 * anything refuses. A `page` block must name a live subpage of this item.
 *
 * Lock order: the item row, then all live subpage rows in id order, then the document. A direct subpage trash locks
 * its row and then this document, so taking the document first could deadlock. Two replaces of one item serialize on
 * the item row and the second fails the etag comparison. An item without a document locks nothing, so the etag is
 * compared again on the document `getOrCreateDoc` returns before writing.
 *
 * Then: subpages no longer linked are trashed through the choke point (a subpage never linked is left alone), subpages
 * whose caption changed are renamed, and the document is diffed in one update (`planBlockDiff`; unchanged blocks keep
 * their ids).
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
    // Locked since `lockLiveChildPageIds`; a missing row means the lock was not held.
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
        // No document locked nothing: one committed concurrently is only visible here, under its row lock.
        const lockedEtag = docEtag(ydoc);
        if (lockedEtag !== input.expectedEtag) throw new PageVersionConflictError(lockedEtag);
      }
      applyBlockDiff(ydoc, planBlockDiff(realBlocks(ydoc), blocks));
    });
  }
  return { etag: await etagOfItemPage(client, host.id), trashedPages };
}

export interface PageReplaceCheckResult {
  docId: string | null;
  etag: string;
}

/**
 * Read-only version of `replacePageMarkdown`'s refusals, for approvals. It locks only the item row, never a subpage or
 * the document, so it cannot take locks in a different order than the replace that follows.
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
