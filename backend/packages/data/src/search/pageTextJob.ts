import { readPageBlocks, serializeBlocks } from "@semprec/block-model";
import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { loadDocWithClient } from "../docs/docPersistence.js";
import { syncJournalEventLinks } from "../journal/journalEventLinks.js";
import { computeJournalSummary, recomputeJournalSummary } from "../journal/journalSummary.js";
import { EMAILS_MODULE_ID } from "../seed/emailModuleKeys.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { indexItem } from "./itemSearchIndexer.js";
import { stripMarkdown } from "./stripMarkdown.js";

/** Longer page text is cut to this many characters before it is stored. */
const PAGE_TEXT_MAX_CHARS = 100_000;

const payloadSchema = z.object({ itemId: z.uuid() }).strict();

interface OwnerRow {
  /** The item's page doc, or null when it has none (a canvas-only item, or one that never got a page). */
  doc_id: string | null;
  database_id: string;
  owner_module_id: string | null;
}

/**
 * The `itemSearchPageText` task (issue #1658): converts the owner item's page to plain text and rebuilds its index
 * row. A missing, soft-deleted or Emails item completes without writing. An item with no page doc completes without
 * writing too, except a Journal entry, whose summary is recomputed as null (issue #1711). For a Journal entry the same
 * transaction also recomputes `computed.journalSummary` from the page's Markdown and makes its `events` relation equal to
 * the page's event links (issue #2016), from the same serialized Markdown. The page text, the index row, the summary and
 * the event edges are written in one transaction, so they commit together or not at all.
 */
export async function handleItemSearchPageTextTask(pool: Pool, payload: unknown): Promise<void> {
  const { itemId } = payloadSchema.parse(payload);
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query<OwnerRow>(
      `SELECT d.id AS doc_id, i.database_id, db.owner_module_id
       FROM items i
       JOIN databases db ON db.id = i.database_id
       LEFT JOIN docs d ON d.item_id = i.id AND d.kind = 'page'
       WHERE i.id = $1 AND i.deleted_at IS NULL AND db.owner_module_id IS DISTINCT FROM $2`,
      [itemId, EMAILS_MODULE_ID],
    );
    const item = rows[0];
    if (!item) return;
    const isJournalEntry = item.owner_module_id === JOURNAL_MODULE_ID;
    if (item.doc_id === null) {
      if (isJournalEntry) await recomputeJournalSummary(client, item.database_id, itemId, null);
      return;
    }
    const ydoc = await loadDocWithClient(client, item.doc_id);
    const markdown = serializeBlocks(readPageBlocks(ydoc));
    await indexItem(client, itemId, { pageText: stripMarkdown(markdown, PAGE_TEXT_MAX_CHARS) });
    if (isJournalEntry) {
      await recomputeJournalSummary(client, item.database_id, itemId, computeJournalSummary(markdown));
      await syncJournalEventLinks(client, itemId, markdown);
    }
  });
}
