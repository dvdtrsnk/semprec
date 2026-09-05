import { z } from "zod";
import { registerViewType, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";

/**
 * The mailbox's own view type (issue #96, epic #92): a folder sidebar + message list +
 * reading pane, registered exactly like Journal's `temporal-switcher` — not configuration
 * on top of the generic table renderer, whose interaction model is too different.
 *
 * Everything the client needs to read a mailbox is in this config, and all of it is read
 * through the *generic* operations (listItems/countItems with a filter tree, getItem,
 * queryView): the folder sidebar lists items of `foldersDatabaseId`, the message list
 * filters Emails through the Emails->Folders relation named by `folderRelationKey` with a
 * `relation_contains` condition, and unread counts are `countItems` over the same filter
 * plus `readPropertyKey`. There is deliberately no mailbox-only read endpoint underneath.
 *
 * Triage (issue #97) stays on the generic surface the same way: marking a message read or
 * flagged is an item update of `readPropertyKey`/`flaggedPropertyKey`, and archiving or
 * deleting one is a relation write on `folderRelationKey` moving it to the Folders item
 * whose `specialPurpose` is `archive`/`trash`.
 */
export const MAILBOX_CLIENT_VIEW_TYPE = "mailbox-client";

const uuid = z.string().uuid();

export const mailboxClientConfigSchema = z.object({
  /** Folders database whose items the sidebar lists. */
  foldersDatabaseId: uuid,
  /** Relation property on Emails pointing at Folders — the message list's only filter path. */
  folderRelationKey: z.string().min(1).default("folder"),
  /** Checkbox property on Emails carrying read state; absent/false counts as unread. */
  readPropertyKey: z.string().min(1).default("read"),
  /** Checkbox property on Emails carrying flag state; absent/false counts as unflagged. */
  flaggedPropertyKey: z.string().min(1).default("flagged"),
  /** Mailboxes database + item, when this view is scoped to a single account's folders. */
  mailboxesDatabaseId: uuid.optional(),
  mailboxItemId: uuid.optional(),
  /** Relation property on Folders pointing at Mailboxes, used with `mailboxItemId`. */
  mailboxRelationKey: z.string().min(1).default("mailbox"),
});

export type MailboxClientConfig = z.infer<typeof mailboxClientConfigSchema>;

export function registerMailboxClientViewType(registry: ViewTypeRegistry): void {
  registerViewType(registry, MAILBOX_CLIENT_VIEW_TYPE, {
    configSchema: mailboxClientConfigSchema,
    service: {
      validateConfig(config) {
        // Scoping the sidebar to one account needs the database the item lives in as well;
        // without it the client cannot resolve the mailbox item at all, and would silently
        // fall back to showing every folder of every account.
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
