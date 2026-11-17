import { z } from "zod";
import { registerViewType, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { FLAGGED_PROPERTY_KEY, READ_PROPERTY_KEY } from "../mail/messageFlags.js";

/**
 * The mailbox view type (folder sidebar, message list, reading pane), registered like `temporal-switcher` because
 * its interaction model is too different for the table renderer. Everything is read and triaged through generic
 * operations: folders are items of `foldersDatabaseId`, the list filters Emails by `relation_contains` on
 * `folderRelationKey`, unread counts are `countItems` plus `readPropertyKey`, and archive/delete is a relation write
 * to the folder whose `specialPurpose` is `archive`/`trash`. There is deliberately no mailbox-only read endpoint.
 */
export const MAILBOX_CLIENT_VIEW_TYPE = "mailbox-client";

const uuid = z.string().uuid();

export const mailboxClientConfigSchema = z.object({
  foldersDatabaseId: uuid,
  /** The message list's only filter path. */
  folderRelationKey: z.string().min(1).default("folder"),
  /** Absent/false counts as unread. */
  readPropertyKey: z.string().min(1).default(READ_PROPERTY_KEY),
  /** Absent/false counts as unflagged. */
  flaggedPropertyKey: z.string().min(1).default(FLAGGED_PROPERTY_KEY),
  /** Set when the view is scoped to a single account's folders. */
  mailboxesDatabaseId: uuid.optional(),
  mailboxItemId: uuid.optional(),
  /** Used with `mailboxItemId`. */
  mailboxRelationKey: z.string().min(1).default("mailbox"),
});

export type MailboxClientConfig = z.infer<typeof mailboxClientConfigSchema>;

export function registerMailboxClientViewType(registry: ViewTypeRegistry): void {
  registerViewType(registry, MAILBOX_CLIENT_VIEW_TYPE, {
    configSchema: mailboxClientConfigSchema,
    referenceFields: { databaseIds: ["foldersDatabaseId", "mailboxesDatabaseId"], itemIds: ["mailboxItemId"] },
    service: {
      validateConfig(config) {
        // Without the database the client cannot resolve the mailbox item and would silently show every account's folders.
        const { mailboxesDatabaseId, mailboxItemId } = config as MailboxClientConfig;
        if (mailboxItemId !== undefined && mailboxesDatabaseId === undefined) {
          throw new Error("mailboxItemId requires mailboxesDatabaseId");
        }
      },
    },
    // Opaque to the backend; the client resolves this to its renderer component.
    clientComponent: "mailboxClient",
  });
}
