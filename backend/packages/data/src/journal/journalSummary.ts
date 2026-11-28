import { parseMarkdown } from "@alldots/block-model";
import type { PoolClient } from "pg";
import { writeComputedAndAnnounce } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";

/** Declared in the seed's `ComputedKeyRegistry`, so a colliding Journal property key is refused. */
export const JOURNAL_SUMMARY_COMPUTED_KEY = "journalSummary";

/** In code points. */
export const JOURNAL_SUMMARY_MAX_CHARS = 80;

/** Plain text of the first block that has text, whitespace collapsed; `null` when none has text. */
export function computeJournalSummary(markdown: string): string | null {
  for (const block of parseMarkdown(markdown)) {
    const text = (block.text ?? [])
      .map((run) => run.insert)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text !== "") return Array.from(text).slice(0, JOURNAL_SUMMARY_MAX_CHARS).join("");
  }
  return null;
}

/**
 * Locks the row before reading the stored value, so the comparison sees a concurrent recompute's commit. An absent
 * key is not equal to `null`, so the first recompute of an empty entry still writes and announces.
 */
export async function recomputeJournalSummary(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  summary: string | null,
): Promise<void> {
  const item = await itemsStore.lockItemById(client, databaseId, itemId);
  if (!item || item.deletedAt !== null) return;
  if (item.computed[JOURNAL_SUMMARY_COMPUTED_KEY] === summary) return;
  await writeComputedAndAnnounce(client, databaseId, itemId, JOURNAL_SUMMARY_COMPUTED_KEY, summary);
}
