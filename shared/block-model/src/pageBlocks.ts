import * as Y from "yjs";
import {
  BLOCK_TYPE_RULES,
  INLINE_ATTRIBUTES,
  MAX_INDENT,
  MIN_INDENT,
  isBlockType,
  type BlockType,
  type InlineAttributes,
} from "./blockTypes.js";

const ORDER_ARRAY_NAME = "order";
const BLOCKS_MAP_NAME = "blocks";

/** Document order: the ids of the blocks, top to bottom. */
export function getOrderArray(doc: Y.Doc): Y.Array<string> {
  return doc.getArray<string>(ORDER_ARRAY_NAME);
}

/** The block map keyed by id; each value is a `Y.Map` with `sys:id`, `sys:flavour`, `indent`, `done`, `text`, `pageId`. */
export function getBlocksMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(BLOCKS_MAP_NAME);
}

/** One run of a block's text: the `Y.Text` delta shape, restricted to string inserts and known attributes. */
export interface TextRun {
  insert: string;
  attributes?: InlineAttributes;
}

/** A block as read from a document, after read-time normalization. */
export interface PageBlock {
  /** `null` only for the synthetic block of an empty document. */
  id: string | null;
  type: BlockType;
  indent: number;
  done: boolean;
  /** Plain text without attributes for `page` blocks, which carry their title here. */
  text: TextRun[];
  pageId: string | null;
  /** `true` for the empty `text` block an empty document is read as; reading never stores it. */
  synthetic: boolean;
}

/** The shape `validateBlockInput` accepts and `writeBlock` stores. */
export interface BlockInput {
  id: string;
  type: BlockType;
  indent?: number;
  done?: boolean;
  /** Plain text, or runs carrying inline attributes. */
  text?: string | TextRun[];
  pageId?: string;
}

export interface BlockIssue {
  /** The offending field, e.g. `type` or `text[2].attributes.link`. */
  path: string;
  /** Stable machine-readable reason. */
  code:
    | "not_an_object"
    | "invalid_id"
    | "unknown_type"
    | "invalid_indent"
    | "invalid_done"
    | "done_not_allowed"
    | "invalid_text"
    | "invalid_page_id"
    | "page_id_not_allowed"
    | "page_id_required"
    | "page_not_allowed";
  message: string;
}

/** Thrown by `writeBlock` when its input has validation issues; carries them. */
export class BlockInputError extends Error {
  readonly issues: readonly BlockIssue[];

  constructor(issues: readonly BlockIssue[]) {
    super(`Invalid block input: ${issues.map((issue) => `${issue.path} (${issue.code})`).join(", ")}`);
    this.name = "BlockInputError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIndent(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_INDENT && value <= MAX_INDENT;
}

function validateRunAttributes(attributes: unknown, path: string, issues: BlockIssue[]): void {
  if (!isRecord(attributes)) {
    issues.push({ path, code: "invalid_text", message: "attributes must be an object" });
    return;
  }
  for (const [name, value] of Object.entries(attributes)) {
    const attributePath = `${path}.${name}`;
    if (!(INLINE_ATTRIBUTES as readonly string[]).includes(name)) {
      issues.push({ path: attributePath, code: "invalid_text", message: "unknown inline attribute" });
    } else if (name === "link") {
      if (!isRecord(value) || typeof value.href !== "string" || value.href === "") {
        issues.push({ path: attributePath, code: "invalid_text", message: "link must be { href: non-empty string }" });
      }
    } else if (value !== true) {
      issues.push({ path: attributePath, code: "invalid_text", message: "attribute must be true" });
    }
  }
}

function validateText(text: unknown, plainOnly: boolean, issues: BlockIssue[]): void {
  if (typeof text === "string") {
    return;
  }
  if (!Array.isArray(text)) {
    issues.push({ path: "text", code: "invalid_text", message: "text must be a string or an array of runs" });
    return;
  }
  text.forEach((run: unknown, index) => {
    const path = `text[${index}]`;
    if (!isRecord(run) || typeof run.insert !== "string") {
      issues.push({ path, code: "invalid_text", message: "a run must be { insert: string, attributes? }" });
      return;
    }
    if (run.attributes !== undefined) {
      if (plainOnly) {
        issues.push({
          path: `${path}.attributes`,
          code: "invalid_text",
          message: "this block type carries plain text without inline attributes",
        });
      } else {
        validateRunAttributes(run.attributes, `${path}.attributes`, issues);
      }
    }
  });
}

/**
 * Strict validation for server-side writes. Returns every issue found and never throws on
 * bad input; an empty list means `input` is a `BlockInput`. Mapping issues to an HTTP
 * status is the caller's job.
 */
export function validateBlockInput(input: unknown): BlockIssue[] {
  if (!isRecord(input)) {
    return [{ path: "", code: "not_an_object", message: "block input must be an object" }];
  }
  const issues: BlockIssue[] = [];
  if (typeof input.id !== "string" || input.id === "") {
    issues.push({ path: "id", code: "invalid_id", message: "id must be a non-empty string" });
  }
  if (!isBlockType(input.type)) {
    issues.push({ path: "type", code: "unknown_type", message: "type is not in the block type registry" });
    // Without a known type the per-type field rules cannot be applied.
    return issues;
  }
  const rule = BLOCK_TYPE_RULES[input.type];
  if (input.indent !== undefined && !isIndent(input.indent)) {
    issues.push({
      path: "indent",
      code: "invalid_indent",
      message: `indent must be an integer from ${MIN_INDENT} to ${MAX_INDENT}`,
    });
  }
  if (input.done !== undefined) {
    if (!rule.hasDone) {
      issues.push({ path: "done", code: "done_not_allowed", message: "done is only allowed on todo blocks" });
    } else if (typeof input.done !== "boolean") {
      issues.push({ path: "done", code: "invalid_done", message: "done must be a boolean" });
    }
  }
  if (input.text !== undefined) {
    validateText(input.text, !rule.hasInlineAttributes, issues);
  }
  if (rule.hasPageId) {
    if (typeof input.pageId !== "string" || input.pageId === "") {
      issues.push({
        path: "pageId",
        code: input.pageId === undefined ? "page_id_required" : "invalid_page_id",
        message: "page blocks need a non-empty string pageId",
      });
    }
  } else if (input.pageId !== undefined) {
    issues.push({ path: "pageId", code: "page_id_not_allowed", message: "pageId is only allowed on page blocks" });
  }
  return issues;
}

function readRuns(value: unknown): TextRun[] {
  if (typeof value === "string") {
    return value === "" ? [] : [{ insert: value }];
  }
  if (!(value instanceof Y.Text)) {
    return [];
  }
  const runs: TextRun[] = [];
  const delta: unknown = value.toDelta();
  if (!Array.isArray(delta)) return runs;
  const operations: unknown[] = delta;
  for (const op of operations) {
    if (!isRecord(op) || typeof op.insert !== "string" || op.insert === "") {
      continue;
    }
    const sourceAttributes = isRecord(op.attributes) ? op.attributes : {};
    const attributes: InlineAttributes = {};
    if (sourceAttributes.bold === true) attributes.bold = true;
    if (sourceAttributes.italic === true) attributes.italic = true;
    if (sourceAttributes.code === true) attributes.code = true;
    const link = sourceAttributes.link;
    if (isRecord(link) && typeof link.href === "string" && link.href !== "") {
      attributes.link = { href: link.href };
    }
    runs.push(Object.keys(attributes).length > 0 ? { insert: op.insert, attributes } : { insert: op.insert });
  }
  return runs;
}

/** The text of a block type without inline attributes: one plain run, or none when the text is empty. */
function readPlainRuns(value: unknown): TextRun[] {
  const text = readRuns(value)
    .map((run) => run.insert)
    .join("");
  return text === "" ? [] : [{ insert: text }];
}

function normalizeBlock(id: string, block: Y.Map<unknown>): PageBlock {
  const flavour = block.get("sys:flavour");
  const type: BlockType = isBlockType(flavour) ? flavour : "text";
  const rule = BLOCK_TYPE_RULES[type];
  const indent = block.get("indent");
  const pageId = block.get("pageId");
  return {
    id,
    type,
    indent:
      typeof indent === "number" && Number.isInteger(indent) ? Math.min(MAX_INDENT, Math.max(MIN_INDENT, indent)) : 0,
    done: rule.hasDone && block.get("done") === true,
    text: rule.hasInlineAttributes ? readRuns(block.get("text")) : readPlainRuns(block.get("text")),
    pageId: rule.hasPageId && typeof pageId === "string" && pageId !== "" ? pageId : null,
    synthetic: false,
  };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The blocks of a document in document order, normalized for reading. Never mutates `doc`:
 * the first occurrence of a repeated id wins, ids without a block are skipped, blocks absent
 * from `order` follow in ascending id order, and an unknown type or out-of-range field is
 * read as its repaired value while the stored value stays. A document with no blocks reads
 * as one synthetic empty `text` block.
 */
export function readPageBlocks(doc: Y.Doc): PageBlock[] {
  const blocks = getBlocksMap(doc);
  const seen = new Set<string>();
  const result: PageBlock[] = [];
  const push = (id: string): void => {
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    const block = blocks.get(id);
    if (block instanceof Y.Map) {
      result.push(normalizeBlock(id, block));
    }
  };
  for (const id of getOrderArray(doc).toArray()) {
    push(id);
  }
  for (const id of Array.from(blocks.keys()).sort(compareIds)) {
    push(id);
  }
  if (result.length === 0) {
    return [{ id: null, type: "text", indent: 0, done: false, text: [], pageId: null, synthetic: true }];
  }
  return result;
}

function writeText(block: Y.Map<unknown>, text: string | TextRun[] | undefined): void {
  const existing = block.get("text");
  let target: Y.Text;
  if (existing instanceof Y.Text) {
    target = existing;
    target.delete(0, target.length);
  } else {
    target = new Y.Text();
    block.set("text", target);
  }
  if (typeof text === "string") {
    target.insert(0, text);
  } else if (text !== undefined) {
    target.applyDelta(
      text.map((run) =>
        run.attributes ? { insert: run.insert, attributes: { ...run.attributes } } : { insert: run.insert },
      ),
    );
  }
}

/**
 * Creates or replaces one block and appends its id to `order` when it is not there yet.
 * Fields the type does not carry are removed from an existing block. Throws
 * `BlockInputError` for invalid input. Must run inside `doc.transact(...)`.
 */
export function writeBlock(doc: Y.Doc, input: BlockInput): void {
  const issues = validateBlockInput(input);
  if (issues.length > 0) {
    throw new BlockInputError(issues);
  }
  const rule = BLOCK_TYPE_RULES[input.type];
  const blocks = getBlocksMap(doc);
  let block = blocks.get(input.id);
  if (!block) {
    block = new Y.Map<unknown>();
    blocks.set(input.id, block);
  }
  block.set("sys:id", input.id);
  block.set("sys:flavour", input.type);
  block.set("indent", input.indent ?? 0);
  if (rule.hasDone) {
    block.set("done", input.done ?? false);
  } else {
    block.delete("done");
  }
  writeText(block, input.text);
  if (rule.hasPageId) {
    block.set("pageId", input.pageId);
  } else {
    block.delete("pageId");
  }
  const order = getOrderArray(doc);
  if (!order.toArray().includes(input.id)) {
    order.push([input.id]);
  }
}
