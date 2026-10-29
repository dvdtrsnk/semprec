import { parseMarkdown } from "@semprec/block-model";
import type { PoolClient } from "pg";
import { writeComputedAndAnnounce } from "../chokePoint/itemWrites.js";
import * as itemsStore from "../chokePoint/itemsStore.js";

/**
 * `items.computed` key (issue #1711) each Journal entry caches its derived title under: the text of its page's first
 * block, as plain text. Declared into the seed's `ComputedKeyRegistry` (see seed/seedSystem.ts) so a colliding
 * property key on Journal is refused. The stored `name` is not changed by this key.
 */
export const JOURNAL_SUMMARY_COMPUTED_KEY = "journalSummary";

/** Longest summary stored, in characters (code points). */
export const JOURNAL_SUMMARY_MAX_CHARS = 80;

/**
 * The derived title of a Journal entry, from its page's canonical Markdown (issue #1608). It is the plain text of the
 * first block that has text: a leading heading gives its own text, and otherwise the first non-empty line does. Markup
 * is removed by the block parser, whitespace runs are collapsed, and the result is cut to 80 characters. A block without
 * text, such as a page link, is passed over. Returns `null` when no block has text, including empty input.
 */
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
 * Writes `computed.journalSummary` of one Journal entry from the summary of its page, and announces the change after the
 * commit. The write is skipped when the stored value already equals `summary`. An absent key is not equal to `null`, so
 * the first recompute stores `null` for an entry with no text, and that write is announced like any other change.
 *
 * The item row is locked with `FOR UPDATE` before the stored value is read, so the comparison sees the committed value
 * of a concurrent recompute. A missing or soft-deleted entry is left unwritten. Call it inside the caller's transaction.
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
