import * as Y from "yjs";

/**
 * Legacy flat-map block API: free-form `sys:flavour` and `sys:children`, no document order and no validation. New
 * code uses `@alldots/block-model`; this remains for the page-content proposal path.
 */

const BLOCKS_MAP_NAME = "blocks";

export interface BlockInput {
  id: string;
  flavour: string;
  children?: string[];
  /** Stored alongside the sys: fields. */
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
  // sys: fields last, so a caller field like `sys:id` can never override the block's identity.
  for (const [key, value] of Object.entries(input.fields ?? {})) {
    block.set(key, value);
  }
  block.set("sys:id", input.id);
  block.set("sys:flavour", input.flavour);
  block.set("sys:children", input.children ?? block.get("sys:children") ?? []);
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
