import { randomUUID } from "node:crypto";
import { writeBlock } from "@semprec/block-model";
import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { mutateDoc } from "../docs/docPersistence.js";
import { getOrCreateDoc } from "../docs/docsStore.js";

/**
 * Appends one text block per entry to `itemId`'s page through the block model writer and the production doc write
 * path, so the page-text job reads the same shape the editor writes (issue #1658). Each call is one doc update.
 */
export async function writePageTextBlocks(pool: Pool, itemId: string, texts: string[]): Promise<void> {
  const doc = await withTransaction(pool, (client) => getOrCreateDoc(client, itemId, "page"));
  await mutateDoc(pool, doc.id, "user", (ydoc) => {
    for (const text of texts) writeBlock(ydoc, { id: randomUUID(), type: "text", text });
  });
}
