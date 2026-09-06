import { z } from "zod";

/**
 * The client-side parse of a `journal-inbox` view's config. Mirrors the backend's
 * registration schema (backend/packages/data/src/views/journalInboxViewType.ts) — the
 * backend validates on write, this validates on read, since a view's config arrives here as
 * unvalidated JSON like any other API payload.
 */
export const journalInboxConfigSchema = z.object({
  inboxDatabaseId: z.string().min(1),
  journalDayItemId: z.string().min(1),
  journalDayRelationKey: z.string().min(1).default("journalDay"),
  computedKey: z.string().min(1).default("inboxItems"),
});

export type JournalInboxConfig = z.infer<typeof journalInboxConfigSchema>;

export function parseJournalInboxConfig(config: unknown): JournalInboxConfig | null {
  const result = journalInboxConfigSchema.safeParse(config);
  return result.success ? result.data : null;
}
