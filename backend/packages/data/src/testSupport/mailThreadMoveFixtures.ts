import type { Pool } from "pg";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { type BlobStorageWriter } from "../mail/blobStorage.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import { ensureMailFolderSyncState, resetForUidvalidityChange } from "../mail/mailFolderSyncStateStore.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";

/** The `UIDVALIDITY` every folder of an IMAP fixture mailbox is given. */
export const MOVE_FIXTURE_UID_VALIDITY = "7";

export const MOVE_FIXTURE_OWN_ADDRESS = "me@example.test";
export const MOVE_FIXTURE_CLIENT_ADDRESS = "klient@example.test";

export const MOVE_FOLDER_KEYS = ["inbox", "sent", "drafts", "junk", "trash", "archive"] as const;
export type MoveFolderKey = (typeof MOVE_FOLDER_KEYS)[number];

/** The provider id and name each folder gets, by provider kind. A Gmail API mailbox keeps its Archive as a synthetic label. */
const FOLDER_PROVIDER_IDS: Record<"gmail" | "imap", Record<MoveFolderKey, string>> = {
  gmail: {
    inbox: "INBOX",
    sent: "SENT",
    drafts: "DRAFT",
    junk: "SPAM",
    trash: "TRASH",
    archive: "semprec:archive",
  },
  imap: { inbox: "INBOX", sent: "Sent", drafts: "Drafts", junk: "Junk", trash: "Trash", archive: "Archive" },
};

export interface MoveFixtureMailbox {
  id: string;
  kind: "gmail" | "imap";
  /** The folders the mailbox has; one named in `omit` is absent. */
  folders: Partial<Record<MoveFolderKey, string>>;
}

export interface CreateMoveFixtureMailboxInput {
  name: string;
  kind: "gmail" | "imap";
  /** Folders the mailbox does not have, as an IMAP account without an `\Archive` folder. */
  omit?: readonly MoveFolderKey[];
  /** Registers this address as the mailbox's own, which makes mail from it the user's own. */
  ownAddress?: string;
  /** Leaves the mailbox without a `mail_account_sync_state` row (default: the sync mode its kind implies). */
  withoutSyncState?: boolean;
}

/**
 * A mailbox with its folders created the way folder discovery creates them, and the sync state its provider kind
 * implies (`gmail_api` or `imap`; an IMAP folder also gets a `UIDVALIDITY`). Run it inside the tenant scope.
 */
export async function createMoveFixtureMailbox(
  runtime: Pool,
  input: CreateMoveFixtureMailboxInput,
): Promise<MoveFixtureMailbox> {
  return withTransaction(runtime, async (client) => {
    const ids = await resolveMailModuleIds(client);
    const mailboxProperty = await getPropertyByKey(client, ids.foldersDatabaseId, "mailbox");
    if (!mailboxProperty) throw new Error("The Folders database has no mailbox property");
    const mailbox = await createItemWithClient(client, {
      databaseId: ids.mailboxesDatabaseId,
      properties: { name: input.name, provider: input.kind === "gmail" ? "gmail" : "generic" },
    });
    if (input.ownAddress !== undefined) {
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: ids.mailboxesDatabaseId,
        mailboxItemId: mailbox.id,
        address: input.ownAddress,
      });
    }
    if (input.withoutSyncState !== true) {
      await ensureMailAccountSyncState(client, {
        itemId: mailbox.id,
        syncMode: input.kind === "gmail" ? "gmail_api" : "imap",
      });
    }
    const folders: Partial<Record<MoveFolderKey, string>> = {};
    for (const key of MOVE_FOLDER_KEYS) {
      if (input.omit?.includes(key)) continue;
      const providerId = FOLDER_PROVIDER_IDS[input.kind][key];
      const folderId = await ensureFolderItem(client, {
        foldersDatabaseId: ids.foldersDatabaseId,
        mailboxItemId: mailbox.id,
        mailboxRelationPropertyId: mailboxProperty.id,
        providerId,
        name: providerId,
        behavior: input.kind === "gmail" ? "label" : "folder",
        specialPurpose: key,
      });
      if (input.kind === "imap") {
        await ensureMailFolderSyncState(client, folderId);
        await resetForUidvalidityChange(client, folderId, MOVE_FIXTURE_UID_VALIDITY);
      }
      folders[key] = folderId;
    }
    return { id: mailbox.id, kind: input.kind, folders };
  });
}

export interface MoveFixtureMessage {
  /** The RFC 5322 Message-ID; the same id in two mailboxes is two copies of one message. */
  id: string;
  day: number;
  mailbox: MoveFixtureMailbox;
  /** The folders the copy is in, as the provider reports them: one for IMAP, any number for a Gmail API mailbox. */
  folders: readonly MoveFolderKey[];
  refs?: readonly string[];
  from?: string;
  subject?: string;
  /** The IMAP UID of the copy in its folder (IMAP mailboxes only; default: next counter value). */
  uid?: number;
}

/**
 * Ingests messages through the sync writer, with the provider identity their mailbox kind carries: a provider message
 * id for a Gmail API mailbox, a UID on the folder edge for an IMAP one. Run it inside the tenant scope.
 */
export function createMoveFixtureIngest(runtime: Pool, storage: BlobStorageWriter) {
  let nextUid = 10;
  return async (message: MoveFixtureMessage): Promise<string> => {
    const [firstFolder] = message.folders;
    if (firstFolder === undefined) throw new Error("A message needs a folder");
    if (message.mailbox.kind === "imap" && message.folders.length !== 1)
      throw new Error("An IMAP copy is in exactly one folder");
    const uid = message.uid ?? nextUid++;
    const providerMessageId = `gm-${message.id}-${message.mailbox.id}`;
    let itemId: string | null = null;
    for (const folder of message.folders) {
      const folderItemId = message.mailbox.folders[folder];
      if (folderItemId === undefined) throw new Error(`The mailbox has no ${folder} folder`);
      const result = await withTransaction(runtime, async (client) => {
        const ids = await resolveMailModuleIds(client);
        const folderProperty = await getPropertyByKey(client, ids.emailsDatabaseId, "folder");
        const attachmentsProperty = await getPropertyByKey(client, ids.emailsDatabaseId, "attachments");
        if (!folderProperty || !attachmentsProperty) throw new Error("The Emails database lacks a relation property");
        return ingestEmailMessage(client, {
          emailsDatabaseId: ids.emailsDatabaseId,
          filesDatabaseId: ids.filesDatabaseId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentsProperty.id,
          mailboxItemId: message.mailbox.id,
          folderItemId,
          messageId: message.id,
          references: [...(message.refs ?? [])],
          subject: message.subject ?? "Re: Nabídka na web",
          date: new Date(`2026-10-${String(message.day).padStart(2, "0")}T09:00:00Z`),
          envelope: {
            from: { name: "Sender", address: message.from ?? MOVE_FIXTURE_CLIENT_ADDRESS },
            to: [{ name: "Me", address: MOVE_FIXTURE_OWN_ADDRESS }],
          },
          bodyHtml: `<p>${message.id}</p>`,
          ...(message.mailbox.kind === "gmail" ? { providerMessageId } : { folderUid: uid }),
          attachments: [],
          storage,
          storageKeyPrefix: "thread-move-fixtures",
        });
      });
      itemId = result.itemId;
    }
    if (itemId === null) throw new Error("Nothing was ingested");
    return itemId;
  };
}

/** The thread of a message copy. */
export async function moveFixtureThreadOf(runtime: Pool, emailItemId: string): Promise<string> {
  const thread = await runtime.query<{ thread_id: string | null }>(
    "SELECT thread_id FROM mail_message_meta WHERE tenant_id = app_tenant_default() AND item_id = $1",
    [emailItemId],
  );
  const threadId = thread.rows[0]?.thread_id;
  if (!threadId) throw new Error("Message has no thread");
  return threadId;
}

export interface MoveFixtureFolderEdge {
  edgeId: string;
  folderId: string;
  /** The `specialPurpose` of the folder. */
  purpose: string;
  metadata: Record<string, unknown>;
}

/** The folder edges of a message copy, ordered by edge id. Run it inside the tenant scope. */
export async function moveFixtureEdgesOf(runtime: Pool, itemId: string): Promise<MoveFixtureFolderEdge[]> {
  const { rows } = await runtime.query<{
    edge_id: string;
    folder_id: string;
    purpose: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT edge.id AS edge_id, folder.id AS folder_id, folder.properties->>'specialPurpose' AS purpose, edge.metadata
     FROM item_relations edge
     JOIN relation_definitions rd ON rd.id = edge.relation_definition_id
     JOIN properties p ON p.id IN (rd.property_id_a, rd.property_id_b) AND p.key = 'folder'
       AND p.database_id = (SELECT id FROM databases WHERE tenant_id = app_tenant_default() AND owner_module_id = 'emails')
     JOIN items folder ON folder.tenant_id = app_tenant_default()
       AND folder.id = CASE WHEN edge.item_a = $1 THEN edge.item_b ELSE edge.item_a END
     WHERE edge.tenant_id = app_tenant_default() AND (edge.item_a = $1 OR edge.item_b = $1)
     ORDER BY edge.id`,
    [itemId],
  );
  return rows.map((row) => ({
    edgeId: row.edge_id,
    folderId: row.folder_id,
    purpose: row.purpose,
    metadata: row.metadata,
  }));
}

export interface MoveFixtureMoveRow {
  messageItemId: string;
  mailboxItemId: string;
  desiredPurpose: string;
  desiredRevision: string;
  status: string;
  source: unknown;
}

/** The recorded desired moves of the tenant, ordered by message item id. Run it inside the tenant scope. */
export async function moveFixtureMoveRows(runtime: Pool): Promise<MoveFixtureMoveRow[]> {
  const { rows } = await runtime.query<{
    message_item_id: string;
    mailbox_item_id: string;
    desired_purpose: string;
    desired_revision: string;
    status: string;
    source_evidence: unknown;
  }>(
    `SELECT message_item_id, mailbox_item_id, desired_purpose, desired_revision::text AS desired_revision, status, source_evidence
     FROM mail_message_move_sync_state WHERE tenant_id = app_tenant_default() ORDER BY message_item_id`,
  );
  return rows.map((row) => ({
    messageItemId: row.message_item_id,
    mailboxItemId: row.mailbox_item_id,
    desiredPurpose: row.desired_purpose,
    desiredRevision: row.desired_revision,
    status: row.status,
    source: row.source_evidence,
  }));
}

/** The sorted keys of the queued account syncs. The queue belongs to no tenant, so they are read as the superuser. */
export async function moveFixtureAccountSyncJobs(admin: Pool): Promise<string[]> {
  const { rows } = await admin.query<{ key: string }>(
    "SELECT key FROM graphile_worker.jobs WHERE task_identifier = 'mailAccountSync' ORDER BY key",
  );
  return rows.map((row) => row.key).sort();
}

/** The keys of the account syncs of `mailboxes`, sorted. */
export function moveFixtureJobKeys(...mailboxes: MoveFixtureMailbox[]): string[] {
  return mailboxes.map((mailbox) => `mail-account-sync:${mailbox.id}`).sort();
}
