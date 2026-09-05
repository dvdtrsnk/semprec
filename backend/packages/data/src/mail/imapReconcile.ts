import type { PoolClient } from "pg";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/chokePoint.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { ValidationError } from "../errors.js";
import { ingestEmailMessage } from "./ingest.js";
import type { FetchedMessage } from "./providerTypes.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import { ensureMailFolderSyncState, getMailFolderSyncState, recordReconcile, resetForUidvalidityChange } from "./mailFolderSyncStateStore.js";
import { findEmailItemIdByFolderUid, listKnownFolderUids } from "./folderMembershipStore.js";
import { ensureFolderItem } from "./folderDiscovery.js";
import { ensureMailAccountSyncState, recordImapActivity } from "./mailAccountSyncStateStore.js";

export interface ImapFetchedMessage {
  uid: number;
  message: FetchedMessage;
}

export interface ImapFolderSelection {
  uidvalidity: number;
  uidnext: number;
  /** null = server didn't report `HIGHESTMODSEQ` (no CONDSTORE) — see `mail_folder_sync_state.highestmodseq`. */
  highestModSeq: number | null;
}

/**
 * What a sync-mode-specific transport (real `ImapFlowMailClient`, or a fake in tests) must
 * provide — reconcile logic below only ever talks to this interface, never to `imapflow`
 * directly, so it is fully testable without a live IMAP server.
 */
export interface ImapFolderRef {
  path: string;
  /** RFC 6154 special-use attribute (`\Inbox`, `\Sent`, `\Junk`, `\Trash`, `\Drafts`, `\All`, `\Archive`), when the server advertises it. */
  specialUse?: string;
}

export interface ImapMailClient {
  getCapabilities(): Promise<Set<string>>;
  listFolders(): Promise<ImapFolderRef[]>;
  selectFolder(path: string): Promise<ImapFolderSelection>;
  /** Every message with UID >= `sinceUid` — used both for the initial full sync (`sinceUid: 1`) and every incremental pass. */
  fetchMessagesSince(path: string, sinceUid: number): Promise<ImapFetchedMessage[]>;
  /** QRESYNC `VANISHED` since the given MODSEQ; `null` when the server doesn't support QRESYNC (caller falls back to `fetchAllUids`). */
  fetchVanishedSince(path: string, sinceModSeq: number): Promise<number[] | null>;
  /** Every UID currently in the folder — the no-QRESYNC deletion-detection fallback (a full UID diff against what this folder's edges already know, see folderMembershipStore.ts). */
  fetchAllUids(path: string): Promise<number[]>;
  /**
   * The one place a message flag is ever written on this account — every fetch above must
   * stay peek-only regardless of caller. Exists so an explicit user triage action (mark
   * read/unread, flag/unflag — mail/messageFlags.ts maps both onto their IMAP flags) has
   * somewhere to go that isn't a side effect of background/AI reads; nothing in this module
   * calls it itself.
   */
  setMessageFlag(path: string, uid: number, flag: string, value: boolean): Promise<void>;
}

export interface ReconcileImapFolderParams {
  folderItemId: string;
  folderPath: string;
  emailsDatabaseId: string;
  filesDatabaseId: string;
  folderRelationPropertyId: string;
  attachmentsRelationPropertyId: string;
  storage: BlobStorageWriter;
  storageKeyPrefix: string;
  /**
   * Only needed for Gmail-in-IMAP-fallback-mode's label-derived Folder membership (below) —
   * every other IMAP target (iCloud, generic, Outlook) leaves a fetched message's
   * `gmailLabels` undefined, so `syncGmailLabelFolders` is never invoked and these three
   * fields go unused. `reconcileImapAccount` always passes them through since it already has
   * them for the account-level Folder discovery it does itself.
   */
  foldersDatabaseId: string;
  mailboxItemId: string;
  mailboxFolderRelationPropertyId: string;
  /** This mailbox's registered addresses (`Mailboxes.addresses`) — deliveredToAddress's alias-fallback precedence (mail/deliveredTo.ts, issue #93). Defaults to `[]`. */
  mailboxAliases?: string[];
}

const GMAIL_LABEL_TO_PURPOSE: Record<string, string> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Spam": "junk",
  "\\Trash": "trash",
  "\\Draft": "drafts",
  "\\All": "all",
};

/**
 * "Gmail in IMAP fallback mode" (issue #26): derives Folder/label membership from `X-GM-LABELS`
 * instead of the physical folder being synced (`[Gmail]/All Mail`, whose own edge is
 * maintained separately, by the UID-based reconcile above — this only ever *adds* label
 * edges alongside it). Only called when `message.gmailLabels` is present, i.e. only when the
 * IMAP server actually advertised X-GM-EXT-1 (Gmail) — a no-op for iCloud/generic/Outlook.
 */
async function syncGmailLabelFolders(
  dbClient: PoolClient,
  params: ReconcileImapFolderParams,
  relationDefinitionId: string,
  emailItemId: string,
  labels: string[],
): Promise<void> {
  const mappedFolderIds = new Set<string>();
  for (const label of labels) {
    const folderItemId = await ensureFolderItem(dbClient, {
      foldersDatabaseId: params.foldersDatabaseId,
      mailboxItemId: params.mailboxItemId,
      mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
      providerId: label,
      name: label,
      behavior: "label",
      specialPurpose: GMAIL_LABEL_TO_PURPOSE[label] ?? "none",
    });
    mappedFolderIds.add(folderItemId);
    await createRelationWithClient(dbClient, { relationPropertyId: params.folderRelationPropertyId, itemId: emailItemId, targetItemId: folderItemId });
  }

  // Drop any label-derived edge for a label this message no longer carries — never touches
  // the physical `params.folderItemId` (All Mail) edge, which isn't label-derived at all;
  // `folderPaths` restricts this account to syncing only that one physical folder in this
  // mode, so every *other* edge on this relation is guaranteed to be label-derived.
  const currentEdges = await listRelationsForItem(dbClient, relationDefinitionId, emailItemId);
  for (const edge of currentEdges) {
    const otherFolderId = otherSide(edge, emailItemId);
    if (otherFolderId !== params.folderItemId && !mappedFolderIds.has(otherFolderId)) {
      await deleteRelationWithClient(dbClient, { relationPropertyId: params.folderRelationPropertyId, itemId: emailItemId, targetItemId: otherFolderId });
    }
  }
}

/**
 * One folder's reconcile pass (issue #26's IMAP adapter). `UIDVALIDITY` changing between
 * runs invalidates the whole UID cache — the folder was rebuilt server-side — so this always
 * re-derives `sinceUid`/`sinceModSeq` from the (possibly just-reset) sync state rather than
 * trusting a caller-supplied cursor. QRESYNC/CONDSTORE support is a per-call capability
 * check (`CAPABILITY`), not a stored assumption — a server can in principle change what it
 * advertises.
 */
export async function reconcileImapFolder(dbClient: PoolClient, imap: ImapMailClient, params: ReconcileImapFolderParams): Promise<void> {
  const relationDefinition = await getRelationDefinitionByPropertyId(dbClient, params.folderRelationPropertyId);
  if (!relationDefinition) throw new ValidationError(`Folder relation property ${params.folderRelationPropertyId} has no relation definition`);

  const capabilities = await imap.getCapabilities();
  const selection = await imap.selectFolder(params.folderPath);

  let state = await ensureMailFolderSyncState(dbClient, params.folderItemId);
  if (state.uidvalidity !== null && state.uidvalidity !== String(selection.uidvalidity)) {
    await resetForUidvalidityChange(dbClient, params.folderItemId, String(selection.uidvalidity));
    state = (await getMailFolderSyncState(dbClient, params.folderItemId))!;
  }

  const sinceUid = state.uidnext ? Number(state.uidnext) : 1;
  const fetched = await imap.fetchMessagesSince(params.folderPath, sinceUid);
  for (const item of fetched) {
    const result = await ingestEmailMessage(dbClient, {
      emailsDatabaseId: params.emailsDatabaseId,
      filesDatabaseId: params.filesDatabaseId,
      folderRelationPropertyId: params.folderRelationPropertyId,
      attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
      folderItemId: params.folderItemId,
      folderUid: item.uid,
      storage: params.storage,
      storageKeyPrefix: params.storageKeyPrefix,
      mailboxAliases: params.mailboxAliases,
      ...item.message,
    });

    if (item.message.gmailLabels) {
      await syncGmailLabelFolders(dbClient, params, relationDefinition.id, result.itemId, item.message.gmailLabels);
    }
  }

  const supportsQresync = capabilities.has("QRESYNC");
  let vanishedUids: number[] | null = null;
  if (supportsQresync && state.highestmodseq) {
    vanishedUids = await imap.fetchVanishedSince(params.folderPath, Number(state.highestmodseq));
  }
  if (vanishedUids === null && !state.uidvalidity) {
    // Initial sync: nothing to diff against yet.
    vanishedUids = [];
  } else if (vanishedUids === null) {
    const [known, current] = await Promise.all([
      listKnownFolderUids(dbClient, relationDefinition.id, params.folderItemId),
      imap.fetchAllUids(params.folderPath),
    ]);
    const currentSet = new Set(current);
    vanishedUids = known.filter((uid) => !currentSet.has(uid));
  }

  for (const uid of vanishedUids) {
    const emailItemId = await findEmailItemIdByFolderUid(dbClient, relationDefinition.id, params.folderItemId, uid);
    if (emailItemId) {
      await deleteRelationWithClient(dbClient, { relationPropertyId: params.folderRelationPropertyId, itemId: emailItemId, targetItemId: params.folderItemId });
    }
  }

  await recordReconcile(dbClient, {
    itemId: params.folderItemId,
    uidvalidity: String(selection.uidvalidity),
    uidnext: String(selection.uidnext),
    highestmodseq: selection.highestModSeq !== null ? String(selection.highestModSeq) : null,
  });
}

const SPECIAL_USE_TO_PURPOSE: Record<string, string> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Junk": "junk",
  "\\Trash": "trash",
  "\\Drafts": "drafts",
  "\\Archive": "archive",
  "\\All": "all",
};

export interface ReconcileImapAccountParams {
  mailboxItemId: string;
  emailsDatabaseId: string;
  filesDatabaseId: string;
  foldersDatabaseId: string;
  folderRelationPropertyId: string;
  mailboxFolderRelationPropertyId: string;
  attachmentsRelationPropertyId: string;
  storage: BlobStorageWriter;
  storageKeyPrefix: string;
  /** Gmail/Outlook in IMAP fallback mode (issue #26): sync only `[Gmail]/All Mail` (or the equivalent `\All` folder) instead of every folder — `folderPaths` lets the composition root pass exactly `["[Gmail]/All Mail"]` for that mode; label membership is then derived from `X-GM-LABELS` by `syncGmailLabelFolders` below (only when the server actually reports labels — a no-op otherwise). Defaults to every folder the server lists, correct for iCloud/generic IMAP (this adapter's actual default target). */
  folderPaths?: string[];
  /** This mailbox's registered addresses (`Mailboxes.addresses`) — deliveredToAddress's alias-fallback precedence (mail/deliveredTo.ts, issue #93). Defaults to `[]`. */
  mailboxAliases?: string[];
}

/**
 * One IMAP account's full reconcile pass: discovers/creates Folder items, then reconciles
 * each folder in turn. Deliberately does not catch-and-record its own failures here: this
 * whole pass runs inside one caller-owned transaction (mailSyncJob.ts), so an `UPDATE ...
 * last_error` written on the same client a later error then aborts would itself be rolled
 * back — recording sync failures is the caller's job, in its own separate transaction, after
 * this one has already unwound. See mailSyncJob.ts's `handleSyncMailAccountTask`.
 */
export async function reconcileImapAccount(dbClient: PoolClient, imap: ImapMailClient, params: ReconcileImapAccountParams): Promise<void> {
  await ensureMailAccountSyncState(dbClient, { itemId: params.mailboxItemId, syncMode: "imap" });
  const allFolders = await imap.listFolders();
  const folders = params.folderPaths ? allFolders.filter((f) => params.folderPaths!.includes(f.path)) : allFolders;

  for (const folder of folders) {
    const folderItemId = await ensureFolderItem(dbClient, {
      foldersDatabaseId: params.foldersDatabaseId,
      mailboxItemId: params.mailboxItemId,
      mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
      providerId: folder.path,
      name: folder.path,
      behavior: "folder",
      specialPurpose: (folder.specialUse && SPECIAL_USE_TO_PURPOSE[folder.specialUse]) ?? "none",
    });

    await reconcileImapFolder(dbClient, imap, {
      folderItemId,
      folderPath: folder.path,
      emailsDatabaseId: params.emailsDatabaseId,
      filesDatabaseId: params.filesDatabaseId,
      folderRelationPropertyId: params.folderRelationPropertyId,
      attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
      storage: params.storage,
      storageKeyPrefix: params.storageKeyPrefix,
      foldersDatabaseId: params.foldersDatabaseId,
      mailboxItemId: params.mailboxItemId,
      mailboxFolderRelationPropertyId: params.mailboxFolderRelationPropertyId,
      mailboxAliases: params.mailboxAliases,
    });
  }

  // IMAP has no push-vs-poll distinction at this layer — periodic reconcile is the only
  // mechanism (IDLE, when used, just triggers this same pass earlier); a fixed 30-minute
  // horizon is within the issue's stated 15-60 minute reconcile window.
  await recordImapActivity(dbClient, { itemId: params.mailboxItemId, nextExpectedActivityAt: new Date(Date.now() + 30 * 60 * 1000) });
}
