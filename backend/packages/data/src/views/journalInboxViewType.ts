import { z } from "zod";
import { registerViewType, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { JOURNAL_INBOX_COMPUTED_KEY } from "../inbox/journalInboxCompute.js";

/**
 * Lists each Journal day's Inbox items from the day's cached `computed[computedKey]` instead of a live client query
 * over Inbox.
 */
export const JOURNAL_INBOX_VIEW_TYPE = "journal-inbox";

const journalInboxConfigSchema = z.object({
  inboxDatabaseId: z.string().uuid(),
  /** Named directly: the generic view surface has no "current day" context to resolve it from. */
  journalDayItemId: z.string().uuid(),
  journalDayRelationKey: z.string().min(1).default("journalDay"),
  computedKey: z.string().min(1).default(JOURNAL_INBOX_COMPUTED_KEY),
});

export function registerJournalInboxViewType(registry: ViewTypeRegistry): void {
  registerViewType(registry, JOURNAL_INBOX_VIEW_TYPE, {
    configSchema: journalInboxConfigSchema,
    referenceFields: { databaseIds: ["inboxDatabaseId"], itemIds: ["journalDayItemId"] },
    // Opaque to the backend; the client resolves this to its renderer component.
    clientComponent: "journalInboxList",
  });
}
