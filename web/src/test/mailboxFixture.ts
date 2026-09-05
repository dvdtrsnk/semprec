import type { View } from "../api/genericOperations.js";
import type { FakeBackend } from "./fakeOperations.js";

export const EMAILS_DATABASE_ID = "db-emails";
export const FOLDERS_DATABASE_ID = "db-folders";
export const MAILBOXES_DATABASE_ID = "db-mailboxes";
export const MAILBOX_ITEM_ID = "mailbox-personal";
export const VIEW_ID = "view-mailbox";

export const mailboxView: View = {
  id: VIEW_ID,
  databaseId: EMAILS_DATABASE_ID,
  type: "mailbox-client",
  name: "Mailbox",
  clientComponent: "mailboxClient",
  config: {
    foldersDatabaseId: FOLDERS_DATABASE_ID,
    folderRelationKey: "folder",
    readPropertyKey: "read",
    mailboxesDatabaseId: MAILBOXES_DATABASE_ID,
    mailboxItemId: MAILBOX_ITEM_ID,
    mailboxRelationKey: "mailbox",
    sort: [{ property: "date", direction: "desc" }],
  },
};

/** One mailbox with an Inbox (three messages, two unread) and an empty Archive. */
export function createMailboxBackend(): FakeBackend {
  return {
    views: [mailboxView],
    items: [
      { id: MAILBOX_ITEM_ID, databaseId: MAILBOXES_DATABASE_ID, properties: { name: "Personal" } },
      { id: "folder-inbox", databaseId: FOLDERS_DATABASE_ID, properties: { name: "Inbox", specialPurpose: "inbox" } },
      { id: "folder-archive", databaseId: FOLDERS_DATABASE_ID, properties: { name: "Archive", specialPurpose: "archive" } },
      { id: "folder-other-account", databaseId: FOLDERS_DATABASE_ID, properties: { name: "Work inbox", specialPurpose: "inbox" } },
      {
        id: "email-1",
        databaseId: EMAILS_DATABASE_ID,
        properties: { name: "Invoice for March", sender: "billing@example.com", recipients: "me@example.com", body: "Attached.", date: "2026-03-02T10:00:00.000Z", read: false },
      },
      {
        id: "email-2",
        databaseId: EMAILS_DATABASE_ID,
        properties: { name: "Lunch?", sender: "friend@example.com", recipients: "me@example.com", body: "Thursday?", date: "2026-03-01T10:00:00.000Z" },
      },
      {
        id: "email-3",
        databaseId: EMAILS_DATABASE_ID,
        properties: { name: "Newsletter", sender: "news@example.com", recipients: "me@example.com", body: "Read on.", date: "2026-02-27T10:00:00.000Z", read: true },
      },
    ],
    relations: [
      { property: "mailbox", itemId: "folder-inbox", targetItemId: MAILBOX_ITEM_ID },
      { property: "mailbox", itemId: "folder-archive", targetItemId: MAILBOX_ITEM_ID },
      { property: "folder", itemId: "email-1", targetItemId: "folder-inbox" },
      { property: "folder", itemId: "email-2", targetItemId: "folder-inbox" },
      { property: "folder", itemId: "email-3", targetItemId: "folder-inbox" },
    ],
  };
}
