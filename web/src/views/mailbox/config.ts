import { z } from "zod";
import type { FilterNode, SortSpec } from "../../api/genericOperations.js";

/**
 * The client-side parse of a `mailbox-client` view's config. It mirrors the backend's
 * registration schema (backend/packages/data/src/views/mailboxClientViewType.ts) — the
 * backend validates on write, this validates on read, since a view's config arrives here as
 * unvalidated JSON like any other API payload.
 */
export const mailboxConfigSchema = z.object({
  foldersDatabaseId: z.string().min(1),
  folderRelationKey: z.string().min(1).default("folder"),
  readPropertyKey: z.string().min(1).default("read"),
  mailboxesDatabaseId: z.string().min(1).optional(),
  mailboxItemId: z.string().min(1).optional(),
  mailboxRelationKey: z.string().min(1).default("mailbox"),
  sort: z
    .array(z.object({ property: z.string().min(1), direction: z.enum(["asc", "desc"]) }))
    .default([{ property: "date", direction: "desc" }]),
});

export type MailboxConfig = z.infer<typeof mailboxConfigSchema>;

export function parseMailboxConfig(config: unknown): MailboxConfig | null {
  const result = mailboxConfigSchema.safeParse(config);
  return result.success ? result.data : null;
}

/** Messages linked to one folder — the Emails-to-Folders relation is the only filter path. */
export function folderFilter(config: MailboxConfig, folderId: string): FilterNode {
  return { type: "relation_contains", property: config.folderRelationKey, value: folderId };
}

/** Unread in a folder: an absent read flag counts as unread, which `not_equals` already does. */
export function unreadFilter(config: MailboxConfig, folderId: string): FilterNode {
  return {
    type: "and",
    nodes: [folderFilter(config, folderId), { type: "not_equals", property: config.readPropertyKey, value: true }],
  };
}

/** Folders of the one mailbox this view is scoped to, or every folder when it is not scoped. */
export function foldersFilter(config: MailboxConfig): FilterNode | undefined {
  if (!config.mailboxItemId) return undefined;
  return { type: "relation_contains", property: config.mailboxRelationKey, value: config.mailboxItemId };
}

export function messageSort(config: MailboxConfig): SortSpec[] {
  return config.sort;
}
