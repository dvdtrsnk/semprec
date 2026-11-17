import { hasUnsettledMailMove, protectedMailMovesForPass, type MailMoveBaseline } from "./mailMessageMoveSyncStore.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";
import type { PoolClient } from "pg";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { ValidationError } from "../errors.js";
import { ingestEmailMessage } from "./ingest.js";
import type { FetchedMessage } from "./providerTypes.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import {
  ensureMailFolderSyncState,
  getMailFolderSyncState,
  recordReconcile,
  resetForUidvalidityChange,
} from "./mailFolderSyncStateStore.js";
import { findEmailItemIdByFolderUid, listKnownFolderUids } from "./folderMembershipStore.js";
import { ensureFolderItem } from "./folderDiscovery.js";
import { ensureMailAccountSyncState, recordImapActivity } from "./mailAccountSyncStateStore.js";
import type { WritableImapFlag } from "./messageFlags.js";
import { listPendingImapFlagWrites, recordConfirmedMailMessageFlag } from "./mailMessageFlagSyncStore.js";
import { createImapMailFlagWritebackAdapter } from "./mailFlagWriteback.js";
import { applyObservedMailMessageFlags } from "./mailFlagObservation.js";

export interface ImapFetchedMessage {
  uid: number;
  message: FetchedMessage;
}

export interface ImapFolderSelection {
  uidvalidity: number;
  uidnext: number;
  /** null = no CONDSTORE. */
  highestModSeq: number | null;
}

export interface ImapFolderRef {
  path: string;
  /** RFC 6154 special-use attribute, when advertised. */
  specialUse?: string;
}

export interface ImapMailClient {
  prepareMove?(
    path: string,
    uid: number,
  ): Promise<{ uidValidity: string; capabilities: Set<string>; found: boolean } | null>;
  executeMoveStep?(
    step: "move" | "copy" | "mark_deleted" | "expunge",
    sourcePath: string,
    uid: number,
    uidValidity: string,
    targetPath: string,
  ): Promise<import("./mailMoveProviderAdapters.js").SafeImapMoveStepResult>;
  getCapabilities(): Promise<Set<string>>;
  listFolders(): Promise<ImapFolderRef[]>;
  selectFolder(path: string): Promise<ImapFolderSelection>;
  /** At most `limit` messages from `sinceUid` up, lowest UIDs first. */
  fetchMessagesSince(path: string, sinceUid: number, limit: number): Promise<ImapFetchedMessage[]>;
  /** `null` without QRESYNC; the caller then falls back to `fetchAllUids`. */
  fetchVanishedSince(path: string, sinceModSeq: number): Promise<number[] | null>;
  /** No-QRESYNC deletion detection by full UID diff. */
  fetchAllUids(path: string): Promise<number[]>;
  /** Observes provider-side flag changes on known UIDs; `null` modseq fetches every UID's flags. */
  fetchFlagsChangedSince(path: string, sinceModSeq: number | null): Promise<Array<{ uid: number; flags: string[] }>>;
  /** The only flag write; every fetch above must stay peek-only so reads never mark mail as seen. */
  setMessageFlag(path: string, uid: number, flag: WritableImapFlag, value: boolean): Promise<void>;
  /** Used only to keep a sent message's copy in the Sent folder. */
  appendMessage(path: string, raw: Buffer, flags: readonly WritableImapFlag[]): Promise<void>;
  /** Never rejects: callers invoke it during cleanup, possibly after a failure. */
  close(): Promise<void>;
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
  /** Scope of per-mailbox dedup. */
  mailboxItemId: string;
  protectedMoveMessageIds?: ReadonlySet<string>;
  moveBaseline?: MailMoveBaseline;
  /** Used only for Gmail label-derived folders (messages with `gmailLabels`). */
  foldersDatabaseId: string;
  mailboxFolderRelationPropertyId: string;
  /** This mailbox's registered addresses, used as deliveredToAddress's alias fallback. Defaults to `[]`. */
  mailboxAliases?: string[];
  /** How many new messages this call may ingest. Defaults to `IMAP_NEW_MESSAGES_PER_PASS`. */
  maxNewMessages?: number;
}

/**
 * New messages one pass ingests across all folders of an account. A pass is one transaction that holds the tenant's
 * mail-thread guard, so a mailbox with thousands of messages is backfilled over many short passes, each committing
 * its own batch, instead of one pass that blocks every other mail writer and loses everything on a provider error.
 */
export const IMAP_NEW_MESSAGES_PER_PASS = 50;

export interface ReconcileImapFolderResult {
  ingested: number;
  /** `false` when new messages above the last ingested UID are left for a later pass. */
  complete: boolean;
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
 * Gmail over IMAP: derives label Folder edges from `X-GM-LABELS`, alongside the All Mail edge the
 * UID reconcile maintains. Only called when the server reports labels (X-GM-EXT-1).
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
    await createRelationWithClient(
      dbClient,
      { relationPropertyId: params.folderRelationPropertyId, callerItemId: emailItemId, targetItemId: folderItemId },
      EMAILS_RELATION_CONTEXT,
    );
  }

  // Drop edges for labels no longer carried. In this mode only All Mail is synced, so every
  // other edge is label-derived; the All Mail edge itself is never touched.
  const currentEdges = await listRelationsForItem(dbClient, relationDefinitionId, emailItemId);
  for (const edge of currentEdges) {
    const otherFolderId = otherSide(edge, emailItemId);
    if (otherFolderId !== params.folderItemId && !mappedFolderIds.has(otherFolderId)) {
      await deleteRelationWithClient(
        dbClient,
        { relationPropertyId: params.folderRelationPropertyId, callerItemId: emailItemId, targetItemId: otherFolderId },
        EMAILS_RELATION_CONTEXT,
      );
    }
  }
}

/**
 * A changed `UIDVALIDITY` invalidates the UID cache, so cursors are always re-derived from the
 * (possibly reset) sync state. QRESYNC/CONDSTORE support is checked per call, not stored.
 */
export async function reconcileImapFolder(
  dbClient: PoolClient,
  imap: ImapMailClient,
  params: ReconcileImapFolderParams,
): Promise<ReconcileImapFolderResult> {
  await lockMailThreadMutation(dbClient);
  const protectedMoveMessageIds = await protectedMailMovesForPass(
    dbClient,
    params.mailboxItemId,
    params.moveBaseline,
    params.protectedMoveMessageIds,
  );
  const relationDefinition = await getRelationDefinitionByPropertyId(dbClient, params.folderRelationPropertyId);
  if (!relationDefinition)
    throw new ValidationError(`Folder relation property ${params.folderRelationPropertyId} has no relation definition`);

  const capabilities = await imap.getCapabilities();
  const selection = await imap.selectFolder(params.folderPath);

  let state = await ensureMailFolderSyncState(dbClient, params.folderItemId);
  if (state.uidvalidity !== null && state.uidvalidity !== String(selection.uidvalidity)) {
    await resetForUidvalidityChange(dbClient, params.folderItemId, String(selection.uidvalidity));
    state = (await getMailFolderSyncState(dbClient, params.folderItemId))!;
  }

  const sinceUid = state.uidnext ? Number(state.uidnext) : 1;
  const limit = params.maxNewMessages ?? IMAP_NEW_MESSAGES_PER_PASS;
  // One more than the limit tells whether messages remain above this batch.
  const fetched = (await imap.fetchMessagesSince(params.folderPath, sinceUid, limit + 1)).sort((a, b) => a.uid - b.uid);
  const batch = fetched.slice(0, limit);
  const complete = fetched.length <= limit;
  for (const item of batch) {
    const result = await ingestEmailMessage(dbClient, {
      emailsDatabaseId: params.emailsDatabaseId,
      filesDatabaseId: params.filesDatabaseId,
      folderRelationPropertyId: params.folderRelationPropertyId,
      attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
      folderItemId: params.folderItemId,
      mailboxItemId: params.mailboxItemId,
      protectedMoveMessageIds,
      folderUid: item.uid,
      storage: params.storage,
      storageKeyPrefix: params.storageKeyPrefix,
      mailboxAliases: params.mailboxAliases,
      ...item.message,
    });

    if (
      !protectedMoveMessageIds?.has(result.itemId) &&
      !(await hasUnsettledMailMove(dbClient, result.itemId)) &&
      item.message.gmailLabels
    ) {
      await syncGmailLabelFolders(dbClient, params, relationDefinition.id, result.itemId, item.message.gmailLabels);
    }
  }

  // UIDs below sinceUid are never re-fetched, so their flags are refreshed here. Skipped on a
  // folder's first sync, where every message was just ingested with its flags.
  if (state.uidvalidity) {
    const sinceModSeq = capabilities.has("CONDSTORE") && state.highestmodseq ? Number(state.highestmodseq) : null;
    const changedFlags = await imap.fetchFlagsChangedSince(params.folderPath, sinceModSeq);
    for (const { uid, flags } of changedFlags) {
      if (uid >= sinceUid) continue; // already handled by the new-message loop above
      const emailItemId = await findEmailItemIdByFolderUid(dbClient, relationDefinition.id, params.folderItemId, uid);
      if (
        !emailItemId ||
        protectedMoveMessageIds?.has(emailItemId) ||
        (await hasUnsettledMailMove(dbClient, emailItemId))
      )
        continue;
      await applyObservedMailMessageFlags(dbClient, {
        emailsDatabaseId: params.emailsDatabaseId,
        messageItemId: emailItemId,
        flags,
      });
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
    if (
      emailItemId &&
      !protectedMoveMessageIds?.has(emailItemId) &&
      !(await hasUnsettledMailMove(dbClient, emailItemId))
    ) {
      await deleteRelationWithClient(
        dbClient,
        {
          relationPropertyId: params.folderRelationPropertyId,
          callerItemId: emailItemId,
          targetItemId: params.folderItemId,
        },
        EMAILS_RELATION_CONTEXT,
      );
    }
  }

  // A partial batch resumes after its last UID. The modseq read at selection still bounds the flag and vanish
  // checks of the next pass: changes after it have a higher modseq.
  const lastIngested = batch.at(-1);
  await recordReconcile(dbClient, {
    itemId: params.folderItemId,
    uidvalidity: String(selection.uidvalidity),
    uidnext: String(complete || !lastIngested ? selection.uidnext : lastIngested.uid + 1),
    highestmodseq: selection.highestModSeq !== null ? String(selection.highestModSeq) : null,
  });
  return { ingested: batch.length, complete };
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
  protectedMoveMessageIds?: ReadonlySet<string>;
  moveBaseline?: MailMoveBaseline;
  emailsDatabaseId: string;
  filesDatabaseId: string;
  foldersDatabaseId: string;
  folderRelationPropertyId: string;
  mailboxFolderRelationPropertyId: string;
  attachmentsRelationPropertyId: string;
  storage: BlobStorageWriter;
  storageKeyPrefix: string;
  /** Restricts the sync, e.g. to `["[Gmail]/All Mail"]` for Gmail over IMAP (labels come from `X-GM-LABELS`). Defaults to every listed folder. */
  folderPaths?: string[];
  /** This mailbox's registered addresses, used as deliveredToAddress's alias fallback. Defaults to `[]`. */
  mailboxAliases?: string[];
}

export interface ReconcileImapAccountResult {
  /** `false` when new messages are left for a later pass, which the caller must schedule. */
  complete: boolean;
}

/** The inbox first, so a new account shows its current mail before the backfill of other folders. */
function inboxFirst(folders: ImapFolderRef[]): ImapFolderRef[] {
  const isInbox = (folder: ImapFolderRef) => folder.specialUse === "\\Inbox" || folder.path.toUpperCase() === "INBOX";
  return [...folders.filter(isInbox), ...folders.filter((folder) => !isInbox(folder))];
}

/**
 * Discovers Folder items, then reconciles each folder within one pass's budget of new messages. Does not record its
 * own failures: the pass runs in the caller's transaction, so such a write would be rolled back with it.
 * mailSyncJob.ts records sync failures in a separate transaction.
 */
export async function reconcileImapAccount(
  dbClient: PoolClient,
  imap: ImapMailClient,
  params: ReconcileImapAccountParams,
): Promise<ReconcileImapAccountResult> {
  await lockMailThreadMutation(dbClient);
  const protectedMoveMessageIds = await protectedMailMovesForPass(
    dbClient,
    params.mailboxItemId,
    params.moveBaseline,
    params.protectedMoveMessageIds,
  );
  await ensureMailAccountSyncState(dbClient, { itemId: params.mailboxItemId, syncMode: "imap" });
  const allFolders = await imap.listFolders();
  const folders = inboxFirst(
    params.folderPaths ? allFolders.filter((f) => params.folderPaths!.includes(f.path)) : allFolders,
  );

  let budget = IMAP_NEW_MESSAGES_PER_PASS;
  let complete = true;
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

    if (budget === 0) {
      complete = false;
      continue;
    }
    const folderResult = await reconcileImapFolder(dbClient, imap, {
      maxNewMessages: budget,
      folderItemId,
      folderPath: folder.path,
      protectedMoveMessageIds,
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
    budget -= folderResult.ingested;
    if (!folderResult.complete) complete = false;
  }

  const [folderRelationDefinition, mailboxFolderRelationDefinition] = await Promise.all([
    getRelationDefinitionByPropertyId(dbClient, params.folderRelationPropertyId),
    getRelationDefinitionByPropertyId(dbClient, params.mailboxFolderRelationPropertyId),
  ]);
  if (!folderRelationDefinition || !mailboxFolderRelationDefinition) {
    throw new ValidationError("Mail folder relation definitions are missing from the email module schema");
  }
  // Rows only exist where observed != desired, so provider changes are not echoed back.
  const writeback = createImapMailFlagWritebackAdapter(imap);
  const pendingWrites = await listPendingImapFlagWrites(dbClient, {
    folderRelationDefinitionId: folderRelationDefinition.id,
    mailboxFolderRelationDefinitionId: mailboxFolderRelationDefinition.id,
    mailboxItemId: params.mailboxItemId,
  });
  const pendingByFlag = new Map<string, typeof pendingWrites>();
  for (const pending of pendingWrites) {
    if (
      protectedMoveMessageIds?.has(pending.messageItemId) ||
      (await hasUnsettledMailMove(dbClient, pending.messageItemId))
    )
      continue;
    const key = `${pending.messageItemId}:${pending.propertyKey}`;
    const writes = pendingByFlag.get(key) ?? [];
    writes.push(pending);
    pendingByFlag.set(key, writes);
  }
  for (const writes of pendingByFlag.values()) {
    const pending = writes[0]!;
    let allApplied = true;
    for (const write of writes) {
      const outcome = await writeback.write(write);
      if (outcome !== "applied") allApplied = false;
    }
    if (!allApplied) continue;
    await recordConfirmedMailMessageFlag(dbClient, pending.messageItemId, pending.propertyKey, pending.desiredState);
  }

  // Periodic reconcile is the only mechanism here; IDLE just triggers it earlier. An unfinished backfill is due at
  // once, so the sweep resumes it even if the follow-up job is lost.
  await recordImapActivity(dbClient, {
    itemId: params.mailboxItemId,
    nextExpectedActivityAt: complete ? new Date(Date.now() + 30 * 60 * 1000) : new Date(),
    completesInitialSync: complete,
  });
  return { complete };
}
