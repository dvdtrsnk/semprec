import * as Y from "yjs";
import { BLOCK_TYPE_RULES, MAX_INDENT, MIN_INDENT, isBlockType, type BlockType } from "./blockTypes.js";
import {
  BlockInputError,
  getBlocksMap,
  getOrderArray,
  readPageBlocks,
  validateBlockInput,
  writeBlock,
  type BlockInput,
  type PageBlock,
  type TextRun,
} from "./pageBlocks.js";

/**
 * Multi-block edits on the shared block model. Every function validates against the current
 * state first, so a refusal changes nothing. Successful nonempty operations perform their changes
 * in one `doc.transact` carrying the optional `origin`; empty operations do not write. Within that
 * transaction `order` is tidied:
 * repeated ids keep their first occurrence, ids without a block are dropped and blocks missing
 * from `order` are appended in ascending id order, which is the order readers already see.
 * Nothing here touches the database. Page blocks can be inserted, moved and deleted; operations
 * that convert, split, merge or duplicate a page block refuse it.
 */

export type BlockOperationErrorCode =
  | "block_not_found"
  | "invalid_after_id"
  | "duplicate_block_id"
  | "offset_out_of_range"
  | "invalid_delta"
  | "no_previous_block"
  | "page_block_not_splittable"
  | "page_block_not_mergeable"
  | "block_already_page"
  | "page_conversion_required";

/** Thrown when an operation is refused; the document is unchanged. */
export class BlockOperationError extends Error {
  readonly code: BlockOperationErrorCode;

  constructor(code: BlockOperationErrorCode, message: string) {
    super(message);
    this.name = "BlockOperationError";
    this.code = code;
  }
}

/** A block to insert; a missing `id` is assigned. */
export type NewBlockInput = Omit<BlockInput, "id"> & { id?: string };

function newBlockId(): string {
  return crypto.randomUUID();
}

function assertNewBlockId(doc: Y.Doc, id: string, reserved: ReadonlySet<string> = new Set()): void {
  if (getBlocksMap(doc).has(id) || reserved.has(id)) {
    throw new BlockOperationError("duplicate_block_id", `Block ${id} already exists`);
  }
}

/** The real blocks in normalized document order; empty for a document read as the synthetic block. */
function currentBlocks(doc: Y.Doc): PageBlock[] {
  return readPageBlocks(doc).filter((block) => !block.synthetic);
}

function requireBlocks(current: readonly PageBlock[], ids: readonly string[]): Set<string> {
  const known = new Set(current.map((block) => block.id));
  const wanted = new Set(ids);
  for (const id of wanted) {
    if (!known.has(id)) {
      throw new BlockOperationError("block_not_found", `Block ${id} does not exist`);
    }
  }
  return wanted;
}

function requireAfterId(current: readonly PageBlock[], afterId: string | null): void {
  if (afterId !== null && !current.some((block) => block.id === afterId)) {
    throw new BlockOperationError("invalid_after_id", `Block ${afterId} does not exist`);
  }
}

/** Rewrites `order` to the normalized order with the fewest edits. Must run inside a transaction. */
function tidyOrder(doc: Y.Doc, current: readonly PageBlock[]): void {
  const order = getOrderArray(doc);
  const valid = new Set(current.map((block) => block.id as string));
  const seen = new Set<string>();
  const stale: number[] = [];
  order.toArray().forEach((id, index) => {
    if (!valid.has(id) || seen.has(id)) {
      stale.push(index);
    } else {
      seen.add(id);
    }
  });
  for (const index of stale.reverse()) {
    order.delete(index, 1);
  }
  const missing = current.map((block) => block.id as string).filter((id) => !seen.has(id));
  if (missing.length > 0) {
    order.push(missing);
  }
}

function indexAfter(doc: Y.Doc, afterId: string | null): number {
  return afterId === null ? 0 : getOrderArray(doc).toArray().indexOf(afterId) + 1;
}

function removeEveryOccurrence(doc: Y.Doc, ids: ReadonlySet<string>): void {
  const order = getOrderArray(doc);
  const entries = order.toArray();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (ids.has(entries[index] as string)) {
      order.delete(index, 1);
    }
  }
}

function blockMap(doc: Y.Doc, id: string): Y.Map<unknown> {
  const block = getBlocksMap(doc).get(id);
  if (!(block instanceof Y.Map)) {
    throw new BlockOperationError("block_not_found", `Block ${id} does not exist`);
  }
  return block;
}

function textOf(block: Y.Map<unknown>): Y.Text {
  const existing = block.get("text");
  if (existing instanceof Y.Text) {
    return existing;
  }
  const created = new Y.Text();
  block.set("text", created);
  return created;
}

function runLength(runs: readonly TextRun[]): number {
  return runs.reduce((sum, run) => sum + run.insert.length, 0);
}

function sliceRuns(runs: readonly TextRun[], from: number): TextRun[] {
  const result: TextRun[] = [];
  let position = 0;
  for (const run of runs) {
    const end = position + run.insert.length;
    if (end > from) {
      const insert = run.insert.slice(Math.max(0, from - position));
      result.push(run.attributes ? { insert, attributes: run.attributes } : { insert });
    }
    position = end;
  }
  return result;
}

function toInput(block: PageBlock, id: string): BlockInput {
  const input: BlockInput = { id, type: block.type, indent: block.indent };
  if (BLOCK_TYPE_RULES[block.type].hasDone) {
    input.done = block.done;
  }
  input.text = block.text;
  if (block.pageId !== null) {
    input.pageId = block.pageId;
  }
  return input;
}

/** Inserts `blocks` after `afterId` (`null` is the start) in the given order and returns their ids. */
export function insertBlocks(
  doc: Y.Doc,
  afterId: string | null,
  blocks: readonly NewBlockInput[],
  origin?: unknown,
): string[] {
  const current = currentBlocks(doc);
  requireAfterId(current, afterId);
  const existing = new Set<string>();
  const prepared: BlockInput[] = [];
  for (const block of blocks) {
    const candidate =
      typeof block === "object" && block !== null && block.id === undefined ? { ...block, id: newBlockId() } : block;
    const issues = validateBlockInput(candidate);
    if (issues.length > 0) {
      throw new BlockInputError(issues);
    }
    const input = candidate as BlockInput;
    assertNewBlockId(doc, input.id, existing);
    existing.add(input.id);
    prepared.push(input);
  }
  if (prepared.length === 0) {
    return [];
  }
  doc.transact(() => {
    tidyOrder(doc, current);
    const ids = prepared.map((input) => input.id);
    // Placing the ids first makes writeBlock keep them where they are instead of appending.
    getOrderArray(doc).insert(indexAfter(doc, afterId), ids);
    for (const input of prepared) {
      writeBlock(doc, input);
    }
  }, origin);
  return prepared.map((input) => input.id);
}

/** Splits the block at `offset` and returns the id of the new block that follows it. */
export function splitBlock(doc: Y.Doc, id: string, offset: number, origin?: unknown): string {
  const current = currentBlocks(doc);
  requireBlocks(current, [id]);
  const source = current.find((block) => block.id === id) as PageBlock;
  if (source.type === "page") {
    throw new BlockOperationError("page_block_not_splittable", "A page block cannot be split");
  }
  const length = runLength(source.text);
  if (!Number.isInteger(offset) || offset < 0 || offset > length) {
    throw new BlockOperationError("offset_out_of_range", `Offset ${offset} is outside 0..${length}`);
  }
  const newId = newBlockId();
  assertNewBlockId(doc, newId);
  doc.transact(() => {
    tidyOrder(doc, current);
    const text = textOf(blockMap(doc, id));
    text.delete(offset, text.length - offset);
    getOrderArray(doc).insert(indexAfter(doc, id), [newId]);
    const input: BlockInput = {
      id: newId,
      type: source.type,
      indent: source.indent,
      text: sliceRuns(source.text, offset),
    };
    if (BLOCK_TYPE_RULES[source.type].hasDone) {
      input.done = false;
    }
    writeBlock(doc, input);
  }, origin);
  return newId;
}

/** Joins block `id` into the block before it; the earlier block keeps its id, type and indent. */
export function mergeBlocks(doc: Y.Doc, id: string, origin?: unknown): void {
  const current = currentBlocks(doc);
  requireBlocks(current, [id]);
  const index = current.findIndex((block) => block.id === id);
  const later = current[index] as PageBlock;
  const earlier = current[index - 1];
  if (earlier === undefined) {
    throw new BlockOperationError("no_previous_block", "The block has no previous block");
  }
  if (earlier.type === "page" || later.type === "page") {
    throw new BlockOperationError("page_block_not_mergeable", "A page block cannot be merged");
  }
  doc.transact(() => {
    tidyOrder(doc, current);
    const text = textOf(blockMap(doc, earlier.id as string));
    let position = text.length;
    for (const run of later.text) {
      // An explicit attribute object keeps formatting of the earlier text from leaking in.
      text.insert(position, run.insert, { ...run.attributes });
      position += run.insert.length;
    }
    getBlocksMap(doc).delete(id);
    removeEveryOccurrence(doc, new Set([id]));
  }, origin);
}

/** Moves the blocks after `afterId`, keeping their current relative order. */
export function moveBlocks(doc: Y.Doc, ids: readonly string[], afterId: string | null, origin?: unknown): void {
  const current = currentBlocks(doc);
  const selected = requireBlocks(current, ids);
  requireAfterId(current, afterId);
  if (afterId !== null && selected.has(afterId)) {
    throw new BlockOperationError("invalid_after_id", "afterId must not be one of the moved blocks");
  }
  if (selected.size === 0) {
    return;
  }
  const ordered = current.map((block) => block.id as string).filter((id) => selected.has(id));
  doc.transact(() => {
    tidyOrder(doc, current);
    removeEveryOccurrence(doc, selected);
    getOrderArray(doc).insert(indexAfter(doc, afterId), ordered);
  }, origin);
}

/** Changes the type of each block and resets `done`; refuses any conversion from or to `page`. */
export function setType(doc: Y.Doc, ids: readonly string[], type: BlockType, origin?: unknown): void {
  if (!isBlockType(type)) {
    throw new BlockInputError([{ path: "type", code: "unknown_type", message: "unknown block type" }]);
  }
  const current = currentBlocks(doc);
  const selected = requireBlocks(current, ids);
  if (selected.size === 0) {
    return;
  }
  if (type === "page" || current.some((block) => selected.has(block.id as string) && block.type === "page")) {
    throw new BlockOperationError(
      "page_conversion_required",
      "Converting to or from a page block needs the page layer",
    );
  }
  doc.transact(() => {
    tidyOrder(doc, current);
    for (const id of selected) {
      const block = blockMap(doc, id);
      block.set("sys:flavour", type);
      if (BLOCK_TYPE_RULES[type].hasDone) {
        block.set("done", false);
      } else {
        block.delete("done");
      }
    }
  }, origin);
}

/**
 * Converts each selected block into a `page` block in place (issue #2013): the id and the position stay, the type
 * becomes `page`, `pageId` is `pageIdFor(id)` and the block's text stays as the plain-text title (inline attributes are
 * dropped; `done` goes with the old type). Refuses a repeated id (`duplicate_block_id`), an unknown id
 * (`block_not_found`) and a block that is already a page (`block_already_page`) before changing anything; the one
 * `doc.transact` then converts every block or none. This is the page layer's counterpart of `setType`, which still
 * refuses every conversion to or from `page`.
 */
export function convertBlocksToPages(
  doc: Y.Doc,
  ids: readonly string[],
  pageIdFor: (blockId: string) => string,
  origin?: unknown,
): void {
  if (new Set(ids).size !== ids.length) {
    throw new BlockOperationError("duplicate_block_id", "A block id is listed twice");
  }
  const current = currentBlocks(doc);
  const selected = requireBlocks(current, ids);
  if (selected.size === 0) {
    return;
  }
  const selectedBlocks = current.flatMap((block) =>
    block.id !== null && selected.has(block.id) ? [{ block, id: block.id }] : [],
  );
  const already = selectedBlocks.find(({ block }) => block.type === "page");
  if (already) {
    throw new BlockOperationError("block_already_page", `Block ${already.id} is already a page block`);
  }
  const conversions: BlockInput[] = selectedBlocks.map(({ block, id }) => ({
    id,
    type: "page",
    indent: block.indent,
    pageId: pageIdFor(id),
    text: block.text.map((run) => run.insert).join(""),
  }));
  const issues = conversions.flatMap((input) => validateBlockInput(input));
  if (issues.length > 0) {
    throw new BlockInputError(issues);
  }
  doc.transact(() => {
    tidyOrder(doc, current);
    for (const input of conversions) {
      writeBlock(doc, input);
    }
  }, origin);
}

/** Adds `delta` to the indent of each block, clamped to the allowed range. */
export function setIndent(doc: Y.Doc, ids: readonly string[], delta: number, origin?: unknown): void {
  if (!Number.isInteger(delta)) {
    throw new BlockOperationError("invalid_delta", "delta must be an integer");
  }
  const current = currentBlocks(doc);
  const selected = requireBlocks(current, ids);
  if (selected.size === 0) {
    return;
  }
  doc.transact(() => {
    tidyOrder(doc, current);
    for (const block of current) {
      if (selected.has(block.id as string)) {
        blockMap(doc, block.id as string).set(
          "indent",
          Math.min(MAX_INDENT, Math.max(MIN_INDENT, block.indent + delta)),
        );
      }
    }
  }, origin);
}

/** Inserts copies right after the last selected block, in their relative order; returns the new ids. */
export function duplicateBlocks(doc: Y.Doc, ids: readonly string[], origin?: unknown): string[] {
  const current = currentBlocks(doc);
  const selected = requireBlocks(current, ids);
  const sources = current.filter((block) => selected.has(block.id as string));
  if (sources.some((block) => block.type === "page")) {
    throw new BlockOperationError("page_conversion_required", "Duplicating a page block needs the page layer");
  }
  const last = sources[sources.length - 1];
  if (last === undefined) {
    return [];
  }
  const reserved = new Set<string>();
  const copies = sources.map((block) => {
    const id = newBlockId();
    assertNewBlockId(doc, id, reserved);
    reserved.add(id);
    return toInput(block, id);
  });
  doc.transact(() => {
    tidyOrder(doc, current);
    getOrderArray(doc).insert(
      indexAfter(doc, last.id),
      copies.map((copy) => copy.id),
    );
    for (const copy of copies) {
      writeBlock(doc, copy);
    }
  }, origin);
  return copies.map((copy) => copy.id);
}

/** Removes the blocks and every occurrence of their ids; an emptied document keeps one empty text block. */
export function deleteBlocks(doc: Y.Doc, ids: readonly string[], origin?: unknown): void {
  const current = currentBlocks(doc);
  const selected = requireBlocks(current, ids);
  if (selected.size === 0) {
    return;
  }
  const emptyId = selected.size === current.length ? newBlockId() : undefined;
  if (emptyId !== undefined) assertNewBlockId(doc, emptyId);
  doc.transact(() => {
    tidyOrder(doc, current);
    const blocks = getBlocksMap(doc);
    for (const id of selected) {
      blocks.delete(id);
    }
    removeEveryOccurrence(doc, selected);
    if (emptyId !== undefined) {
      writeBlock(doc, { id: emptyId, type: "text" });
    }
  }, origin);
}
