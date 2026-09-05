import type { GenericOperations, Item } from "../../api/genericOperations.js";
import type { MailboxConfig } from "./config.js";

/**
 * The accounts behind the folders on screen. Compose needs them for two things: the registered
 * aliases the From dropdown offers, and which account a folder belongs to — the context a new
 * message defaults its sender from. Both are ordinary generic reads of the Mailboxes database
 * and the Folders-to-Mailboxes relation, not a mailbox-only endpoint.
 */
export async function loadMailboxes(operations: GenericOperations, config: MailboxConfig): Promise<Item[]> {
  if (!config.mailboxesDatabaseId) return [];
  // A view scoped to one mailbox must not offer another account's aliases, so it reads exactly
  // that one item instead of the whole database.
  if (config.mailboxItemId) {
    const mailbox = await operations.getItem(config.mailboxesDatabaseId, config.mailboxItemId);
    return mailbox ? [mailbox] : [];
  }
  const page = await operations.listItems(config.mailboxesDatabaseId, { limit: 50 });
  return page.items;
}

/**
 * Which mailbox each folder belongs to. A scoped view already knows — every folder it lists is
 * that mailbox's — so it costs nothing there; an unscoped one asks per account, which is one
 * query per mailbox rather than one per folder.
 */
export async function loadFolderMailboxes(
  operations: GenericOperations,
  config: MailboxConfig,
  folders: readonly Item[],
  mailboxes: readonly Item[],
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  if (config.mailboxItemId) {
    for (const folder of folders) map[folder.id] = config.mailboxItemId;
    return map;
  }
  for (const mailbox of mailboxes) {
    const page = await operations.listItems(config.foldersDatabaseId, {
      filter: { type: "relation_contains", property: config.mailboxRelationKey, value: mailbox.id },
      limit: 200,
    });
    for (const folder of page.items) map[folder.id] = mailbox.id;
  }
  return map;
}
