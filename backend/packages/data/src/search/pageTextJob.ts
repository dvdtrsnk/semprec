import { readPageBlocks, serializeBlocks } from "@semprec/block-model";
import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { loadDocWithClient } from "../docs/docPersistence.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { indexItem } from "./itemSearchIndexer.js";
import { stripMarkdown } from "./stripMarkdown.js";

/** Longer page text is cut to this many characters before it is stored. */
const PAGE_TEXT_MAX_CHARS = 100_000;

const payloadSchema = z.object({ itemId: z.uuid() }).strict();

/**
 * The `itemSearchPageText` task (issue #1658): converts the owner item's page to plain text and rebuilds its index
 * row. A missing, soft-deleted or Emails item, and an item with no page doc, completes without writing. The page
 * text and the index row are written in one transaction, so they commit together or not at all.
 */
export async function handleItemSearchPageTextTask(pool: Pool, payload: unknown): Promise<void> {
  const { itemId } = payloadSchema.parse(payload);
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ doc_id: string }>(
      `SELECT d.id AS doc_id FROM docs d
       JOIN items i ON i.id = d.item_id
       JOIN databases db ON db.id = i.database_id
       WHERE d.item_id = $1 AND d.kind = 'page' AND i.deleted_at IS NULL
         AND db.owner_module_id IS DISTINCT FROM $2`,
      [itemId, EMAILS_MODULE_ID],
    );
    const doc = rows[0];
    if (!doc) return;
    const ydoc = await loadDocWithClient(client, doc.doc_id);
    const pageText = stripMarkdown(serializeBlocks(readPageBlocks(ydoc)), PAGE_TEXT_MAX_CHARS);
    await indexItem(client, itemId, { pageText });
  });
}
