import { serializeBlocks, type NewBlockInput, type PageBlock, type SerializableBlock } from "@semprec/block-model";

/**
 * The largest product of the two block counts the pairing below fills in. Blocks the page shares at its start and at
 * its end are paired without counting; only the changed stretch between them is compared block by block, and a stretch
 * past this size is not compared at all.
 */
export const MAX_DIFF_CELLS = 4_000_000;

/** A block of the new body: a block to insert, with the fresh id it would get. */
export type DiffNewBlock = NewBlockInput & { id: string };

/** One run of new blocks to insert directly after `afterId` (`null` is the start of the page), in the order given. */
export interface BlockInsertion {
  afterId: string | null;
  blocks: DiffNewBlock[];
}

/** What turns the blocks a page has into the blocks of a new body; apply every insertion before the deletion. */
export interface BlockDiff {
  insertions: BlockInsertion[];
  /** Ids of current blocks that no new block pairs with. */
  deleteIds: string[];
  /**
   * For each id of `deleteIds`, the id of the block after which, once the diff is applied, the place the deleted block
   * held now lies (`null`: the start of the page). See `placesOfDeletedBlocks`.
   */
  placeAfter: ReadonlyMap<string, string | null>;
}

/** The text of a `page` block or a plain run list, as the Markdown read writes it into a link caption. */
function plainText(text: PageBlock["text"] | string | undefined): string {
  if (typeof text === "string") return text;
  return (text ?? []).map((run) => run.insert).join("");
}

/**
 * The content of a block as the Markdown read shows it: its canonical Markdown with a fixed id, so two blocks with
 * different ids but the same type, indent, `done`, text, formatting and page link have the same key, and what the
 * Markdown cannot tell apart is not told apart here either. A `page` block counts its own caption and its page id
 * without case.
 */
function contentKey(block: {
  type: string;
  indent?: number;
  done?: boolean;
  text?: PageBlock["text"] | string;
  pageId?: string | null;
}): string {
  const serializable: SerializableBlock = {
    id: "block",
    type: block.type,
    indent: block.indent ?? 0,
    ...(block.done === undefined ? {} : { done: block.done }),
    ...(typeof block.text === "string" ? { text: [{ insert: block.text }] } : block.text ? { text: block.text } : {}),
    pageId: block.pageId?.toLowerCase() ?? null,
  };
  return serializeBlocks([serializable], { resolvePageTitle: () => plainText(block.text) });
}

/**
 * For each new block, the index of the current block it keeps the id of, or `null` when it is inserted. Blocks pair in
 * order: the longest run of equal blocks at the start and at the end, then the longest common subsequence of what lies
 * between, and nothing at all in that middle when it is larger than `MAX_DIFF_CELLS`.
 */
function pairByContent(currentKeys: readonly string[], nextKeys: readonly string[]): Array<number | null> {
  const pairs: Array<number | null> = nextKeys.map(() => null);
  let start = 0;
  while (start < currentKeys.length && start < nextKeys.length && currentKeys[start] === nextKeys[start]) {
    pairs[start] = start;
    start += 1;
  }
  let currentEnd = currentKeys.length;
  let nextEnd = nextKeys.length;
  while (currentEnd > start && nextEnd > start && currentKeys[currentEnd - 1] === nextKeys[nextEnd - 1]) {
    currentEnd -= 1;
    nextEnd -= 1;
    pairs[nextEnd] = currentEnd;
  }
  const rows = currentEnd - start;
  const columns = nextEnd - start;
  if (rows === 0 || columns === 0 || rows * columns > MAX_DIFF_CELLS) return pairs;

  // lengths[i][j]: the longest common subsequence of the current blocks from start + i and the new blocks from start + j.
  const lengths: Uint32Array[] = Array.from({ length: rows + 1 }, () => new Uint32Array(columns + 1));
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      const below = lengths[row + 1]?.[column] ?? 0;
      const right = lengths[row]?.[column + 1] ?? 0;
      lengths[row]![column] =
        currentKeys[start + row] === nextKeys[start + column]
          ? (lengths[row + 1]?.[column + 1] ?? 0) + 1
          : Math.max(below, right);
    }
  }
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (currentKeys[start + row] === nextKeys[start + column]) {
      pairs[start + column] = start + row;
      row += 1;
      column += 1;
    } else if ((lengths[row + 1]?.[column] ?? 0) >= (lengths[row]?.[column + 1] ?? 0)) {
      row += 1;
    } else {
      column += 1;
    }
  }
  return pairs;
}

/**
 * Where each deleted block's place is in the new body, as the id of the block after which it now lies. Between two paired
 * blocks the current blocks that no new block pairs with are replaced by the new blocks that no current block pairs
 * with: the n-th deleted block of such a stretch is succeeded in its place by the n-th new block of the matching
 * stretch (the last one when the new stretch is shorter), and a stretch with no new block leaves its place right after
 * the paired block before it (`null` at the start of the page). A deleted block therefore points at the block that
 * replaced it when its text was changed, and at the block that held the place before it when it was removed.
 */
function placesOfDeletedBlocks(
  current: readonly PageBlock[],
  next: readonly DiffNewBlock[],
  newIndexOfCurrent: ReadonlyArray<number | null>,
): Map<string, string | null> {
  // For each current index, the index in `next` of the first paired block at or after it (`next.length` when none).
  const nextPairedNew: number[] = Array.from({ length: current.length + 1 }, () => next.length);
  for (let index = current.length - 1; index >= 0; index -= 1) {
    nextPairedNew[index] = newIndexOfCurrent[index] ?? nextPairedNew[index + 1] ?? next.length;
  }
  const places = new Map<string, string | null>();
  let stretchStartCurrent = 0;
  let stretchStartNext = 0;
  let pairedId: string | null = null;
  for (const [index, block] of current.entries()) {
    const pairedNew = newIndexOfCurrent[index] ?? null;
    if (pairedNew !== null) {
      stretchStartCurrent = index + 1;
      stretchStartNext = pairedNew + 1;
      pairedId = block.id;
      continue;
    }
    if (block.id === null) continue;
    const stretchLength = (nextPairedNew[index] ?? next.length) - stretchStartNext;
    const replacement =
      stretchLength > 0 ? next[stretchStartNext + Math.min(index - stretchStartCurrent, stretchLength - 1)] : undefined;
    places.set(block.id, replacement?.id ?? pairedId);
  }
  return places;
}

/**
 * Plans the edit that turns `current` (the real blocks of a page in document order) into `next`, keeping the id of
 * every block whose content is unchanged (`pairByContent`) and leaving that block alone. A new block that pairs with
 * none is inserted with the id it carries, directly after the block before it in `next`; a current block that no new
 * block pairs with is deleted. A page that holds only the one empty text block an emptied page keeps is already the
 * empty body, so an empty `next` plans nothing for it.
 */
export function planBlockDiff(current: readonly PageBlock[], next: readonly DiffNewBlock[]): BlockDiff {
  if (next.length === 0 && current.length === 1 && isEmptyPlaceholder(current[0])) {
    return { insertions: [], deleteIds: [], placeAfter: new Map() };
  }
  const pairs = pairByContent(
    current.map((block) => contentKey(block)),
    next.map((block) => contentKey(block)),
  );
  const paired = new Set<number>();
  const newIndexOfCurrent: Array<number | null> = current.map(() => null);
  const insertions: BlockInsertion[] = [];
  let afterId: string | null = null;
  let open: BlockInsertion | null = null;
  for (const [index, block] of next.entries()) {
    const pairedIndex = pairs[index] ?? null;
    const keeps = pairedIndex === null ? undefined : current[pairedIndex];
    if (pairedIndex !== null && keeps?.id != null) {
      paired.add(pairedIndex);
      newIndexOfCurrent[pairedIndex] = index;
      afterId = keeps.id;
      open = null;
      continue;
    }
    if (open === null) {
      open = { afterId, blocks: [] };
      insertions.push(open);
    }
    open.blocks.push(block);
    afterId = block.id;
  }
  const deleteIds = current.flatMap((block, index) => (paired.has(index) || block.id === null ? [] : [block.id]));
  return { insertions, deleteIds, placeAfter: placesOfDeletedBlocks(current, next, newIndexOfCurrent) };
}

/** Whether `block` is the empty text block that deleting every block of a page leaves behind. */
function isEmptyPlaceholder(block: PageBlock | undefined): boolean {
  return block !== undefined && block.type === "text" && block.indent === 0 && plainText(block.text) === "";
}
