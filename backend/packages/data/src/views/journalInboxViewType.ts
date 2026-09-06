import { z } from "zod";
import { registerViewType, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { JOURNAL_INBOX_COMPUTED_KEY } from "../inbox/journalInboxCompute.js";

/**
 * Journal's Inbox-list view type (issue #106): renders each Journal day's related Inbox
 * items as an ordinary list, reading the cached, pre-rendered array off the day item's
 * `computed[computedKey]` (see inbox/journalInboxCompute.ts) rather than the client running
 * its own live filter query over Inbox — the whole point of caching the derived state.
 */
export const JOURNAL_INBOX_VIEW_TYPE = "journal-inbox";

const journalInboxConfigSchema = z.object({
  inboxDatabaseId: z.string().uuid(),
  /** Relation property on Inbox pointing back at the Journal day item — the grouping this view renders by. */
  journalDayRelationKey: z.string().min(1).default("journalDay"),
  /** `items.computed` key on each Journal day item holding the cached list this view renders. */
  computedKey: z.string().min(1).default(JOURNAL_INBOX_COMPUTED_KEY),
});

export function registerJournalInboxViewType(registry: ViewTypeRegistry): void {
  registerViewType(registry, JOURNAL_INBOX_VIEW_TYPE, {
    configSchema: journalInboxConfigSchema,
    // Opaque to the backend; the client resolves this to its renderer component.
    clientComponent: "journalInboxList",
  });
}
