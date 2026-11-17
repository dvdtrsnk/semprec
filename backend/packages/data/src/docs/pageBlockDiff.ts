import { serializeBlocks, type NewBlockInput, type PageBlock, type SerializableBlock } from "@semprec/block-model";

/**
 * Cap on rows x columns of the LCS table for the changed middle stretch (shared prefix/suffix are not counted); past
 * it the middle is not paired at all.
 */
export const MAX_DIFF_CELLS = 4_000_000;

export type DiffNewBlock = NewBlockInput & { id: string };

/** `afterId` `null` is the start of the page. */
export interface BlockInsertion {
  afterId: string | null;
  blocks: DiffNewBlock[];
}

/** Apply every insertion before the deletion. */
export interface BlockDiff {
  insertions: BlockInsertion[];
  deleteIds: string[];
  /** Deleted id -> the block its place now follows (`null`: start of page). See `placesOfDeletedBlocks`. */
  placeAfter: ReadonlyMap<string, string | null>;
}

function plainText(text: PageBlock["text"] | string | undefined): string {
  if (typeof text === "string") return text;
  return (text ?? []).map((run) => run.insert).join("");
}

/** Canonical Markdown with a fixed id, so blocks the Markdown cannot tell apart get the same key. */
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
 * For each new block, the current index whose id it keeps, or `null` (inserted). Pairs the common prefix and suffix,
 * then the LCS of the middle unless it exceeds `MAX_DIFF_CELLS`.
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
 * Within a stretch between paired blocks, the n-th deleted block maps to the n-th inserted block (clamped to the last),
 * or to the preceding paired block when nothing was inserted. So an edited block points at its replacement and a
 * removed one at its predecessor.
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
 * Unchanged blocks keep their ids and are not rewritten. A page holding only the placeholder block an emptied page
 * keeps already is the empty body, so an empty `next` plans nothing.
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

function isEmptyPlaceholder(block: PageBlock | undefined): boolean {
  return block !== undefined && block.type === "text" && block.indent === 0 && plainText(block.text) === "";
}
