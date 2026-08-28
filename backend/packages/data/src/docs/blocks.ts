import * as Y from "yjs";

/**
 * A block is its own `Y.Map` inside the doc's shared `blocks` map, keyed by id — the
 * page tree is a flat map of blocks plus id references, hierarchy arising from
 * `sys:children` rather than from nesting the data structure (issue #23, point 4).
 */
const BLOCKS_MAP_NAME = "blocks";

export interface BlockInput {
  id: string;
  flavour: string;
  children?: string[];
  /** Additional block-type-specific fields (e.g. paragraph text) — stored alongside the sys: fields. */
  fields?: Record<string, unknown>;
}

export type BlockData = Record<string, unknown>;

function getBlocksMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(BLOCKS_MAP_NAME);
}

function toBlockData(block: Y.Map<unknown>): BlockData {
  return Object.fromEntries(block.entries());
}

/** Must run inside `doc.transact(...)` so the resulting mutation is captured as a single `doc_updates` row. */
export function putBlock(doc: Y.Doc, input: BlockInput): void {
  const blocks = getBlocksMap(doc);
  let block = blocks.get(input.id);
  if (!block) {
    block = new Y.Map();
    blocks.set(input.id, block);
  }
  block.set("sys:id", input.id);
  block.set("sys:flavour", input.flavour);
  block.set("sys:children", input.children ?? block.get("sys:children") ?? []);
  for (const [key, value] of Object.entries(input.fields ?? {})) {
    block.set(key, value);
  }
}

export function getBlock(doc: Y.Doc, blockId: string): BlockData | null {
  const block = getBlocksMap(doc).get(blockId);
  return block ? toBlockData(block) : null;
}

export function listBlocks(doc: Y.Doc): BlockData[] {
  return Array.from(getBlocksMap(doc).values()).map(toBlockData);
}

/** Must run inside `doc.transact(...)`. */
export function deleteBlock(doc: Y.Doc, blockId: string): void {
  getBlocksMap(doc).delete(blockId);
}
