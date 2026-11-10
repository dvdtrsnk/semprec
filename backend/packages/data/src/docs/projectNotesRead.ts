import type { PoolClient } from "pg";
import { readPageBlocks, serializeBlocks } from "@semprec/block-model";
import { loadDocWithClient } from "./docPersistence.js";
import { getDocByItemId } from "./docsStore.js";

/** Reads an existing project page and its block captions without creating a document. */
export async function readProjectNotes(
  client: PoolClient,
  itemId: string,
): Promise<{ markdown: string; subpages: { id: string; title: string }[] } | null> {
  const row = await getDocByItemId(client, itemId);
  if (!row || row.kind !== "page") return null;
  const doc = await loadDocWithClient(client, row.id);
  try {
    const blocks = readPageBlocks(doc);
    const title = (block: (typeof blocks)[number]) => (block.text ?? []).map((run) => run.insert).join("");
    const markdown = serializeBlocks(blocks, {
      resolvePageTitle: (_id, block) => (block.text ?? []).map((run) => run.insert).join(""),
    });
    if (markdown === "") return null;
    const subpages = blocks.flatMap((block) =>
      block.id !== null && block.type === "page" && block.pageId ? [{ id: block.pageId, title: title(block) }] : [],
    );
    return { markdown, subpages };
  } finally {
    doc.destroy();
  }
}
