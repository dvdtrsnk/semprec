import { z } from "zod";
import type { FilterNode, Item, SortSpec } from "../../api/genericOperations.js";

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
  flaggedPropertyKey: z.string().min(1).default("flagged"),
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

/**
 * The `specialPurpose` values of the folders whose messages are read by definition (issue #1461). Keep in
 * step with `DRAFTS_AND_SENT_SPECIAL_PURPOSES` in backend/packages/data/src/mail/messageFlags.ts.
 */
const DRAFTS_AND_SENT_PURPOSES: readonly string[] = ["drafts", "sent"];

/**
 * Unread across the folders a view lists, for a view that is not scoped to one folder (issue #1461): a
 * message linked to a Drafts or Sent folder in `folders` is left out, because it is read by definition.
 * Each such folder becomes one `relation_not_contains` edge, so a message that is also in an Inbox is left
 * out as well. `unreadFilter` above stays folder-scoped and is unchanged.
 */
export function unreadOutsideDraftsAndSentFilter(config: MailboxConfig, folders: readonly Item[]): FilterNode {
  const excludedFolders = folders.filter((folder) =>
    DRAFTS_AND_SENT_PURPOSES.some((purpose) => folder.properties.specialPurpose === purpose),
  );
  return {
    type: "and",
    nodes: [
      { type: "not_equals", property: config.readPropertyKey, value: true },
      ...excludedFolders.map((folder): FilterNode => ({
        type: "relation_not_contains",
        property: config.folderRelationKey,
        value: folder.id,
      })),
    ],
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

/**
 * Where archive and delete move a message to: the folder carrying the matching
 * `specialPurpose`, the same stable semantic key the sidebar already sorts by — never a
 * folder matched by its (localized, user-renameable) name.
 */
export const ARCHIVE_FOLDER_PURPOSE = "archive";
export const TRASH_FOLDER_PURPOSE = "trash";

export function folderByPurpose(folders: readonly Item[], purpose: string): Item | null {
  return folders.find((folder) => folder.properties.specialPurpose === purpose) ?? null;
}
