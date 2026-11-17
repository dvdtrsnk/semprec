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
  /** Null for a canvas-only item or one that never got a page. */
  doc_id: string | null;
  database_id: string;
  owner_module_id: string | null;
}

/**
 * Converts the item's page to plain text and rebuilds its index row. Missing, trashed or Emails items, and items
 * without a page doc, complete without writing, except a Journal entry, whose summary becomes null. For a Journal
 * entry it also recomputes `computed.journalSummary` and syncs its `events` relation to the page's event links. All
 * writes share one transaction.
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
