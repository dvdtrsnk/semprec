import type { Pool, PoolClient } from "pg";
import { hasUnsettledMailMove, protectedMailMovesForPass, type MailMoveBaseline } from "./mailMessageMoveSyncStore.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { ingestEmailMessage } from "./ingest.js";
import type { FetchedMessage } from "./providerTypes.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import {
  ensureMailFolderSyncState,
  lockMailFolderSyncState,
  recordReconcile,
  resetForUidvalidityChange,
  type MailFolderSyncStateRow,
} from "./mailFolderSyncStateStore.js";
import { findEmailItemIdByFolderUid, listKnownFolderUids } from "./folderMembershipStore.js";
import { ensureFolderItem } from "./folderDiscovery.js";
import { ensureMailAccountSyncState, recordImapActivity } from "./mailAccountSyncStateStore.js";
import type { WritableImapFlag } from "./messageFlags.js";
import {
  listPendingImapFlagWrites,
  recordConfirmedMailMessageFlag,
  type PendingImapFlagWrite,
} from "./mailMessageFlagSyncStore.js";
import { createImapMailFlagWritebackAdapter } from "./mailFlagWriteback.js";
import { applyObservedMailMessageFlags } from "./mailFlagObservation.js";
import { createAttachmentSpool, type AttachmentSpool } from "./imapAttachmentSpool.js";
import { logger } from "./logger.js";

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
 * New messages one pass ingests across all folders of an account. Everything a pass reads from the provider is
 * fetched with no transaction open; each folder's batch is then written in one short transaction under the tenant's
 * mail-thread guard, so a mailbox with thousands of messages is backfilled over many passes of small batches.
 */
export const IMAP_NEW_MESSAGES_PER_PASS = 10;

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

/** What one folder's provider fetch returned, and the sync state it was computed from. */
interface FetchedImapFolder {
  snapshot: MailFolderSyncStateRow;
  selection: ImapFolderSelection;
  /** The selection's `UIDVALIDITY` differs from the stored one, so the fetch started over from UID 1. */
  uidvalidityChanged: boolean;
  sinceUid: number;
  batch: ImapFetchedMessage[];
  complete: boolean;
  changedFlags: Array<{ uid: number; flags: string[] }>;
  /** Vanished UIDs, or (without QRESYNC) every UID the folder holds now, diffed against the known ones on write. */
  vanished: { kind: "uids"; uids: number[] } | { kind: "current"; uids: number[] };
}

/**
 * The provider half of a folder reconcile, with no transaction open. A changed `UIDVALIDITY` invalidates the UID cache,
 * so the cursors come from the reset state; QRESYNC/CONDSTORE support is checked per pass, not stored.
 */
async function fetchImapFolder(
  imap: ImapMailClient,
  capabilities: Set<string>,
  folderPath: string,
  snapshot: MailFolderSyncStateRow,
  limit: number,
  spool: AttachmentSpool,
): Promise<FetchedImapFolder> {
  const selection = await imap.selectFolder(folderPath);
  const uidvalidityChanged = snapshot.uidvalidity !== null && snapshot.uidvalidity !== String(selection.uidvalidity);
  const state = uidvalidityChanged
    ? { uidvalidity: String(selection.uidvalidity), uidnext: null, highestmodseq: null }
    : snapshot;

  const sinceUid = state.uidnext ? Number(state.uidnext) : 1;
  // One more than the limit tells whether messages remain above this batch.
  const fetched = (await imap.fetchMessagesSince(folderPath, sinceUid, limit + 1)).sort((a, b) => a.uid - b.uid);
  const complete = fetched.length <= limit;
  const batch: ImapFetchedMessage[] = [];
  for (const item of fetched.slice(0, limit)) {
    batch.push({
      uid: item.uid,
      message: { ...item.message, attachments: await spool.spool(item.message.attachments) },
    });
  }

  // UIDs below sinceUid are never re-fetched, so their flags are refreshed here. Skipped on a
  // folder's first sync, where every message is ingested with its flags.
  let changedFlags: Array<{ uid: number; flags: string[] }> = [];
  if (state.uidvalidity) {
    const sinceModSeq = capabilities.has("CONDSTORE") && state.highestmodseq ? Number(state.highestmodseq) : null;
    changedFlags = await imap.fetchFlagsChangedSince(folderPath, sinceModSeq);
  }

  let vanishedUids: number[] | null = null;
  if (capabilities.has("QRESYNC") && state.highestmodseq) {
    vanishedUids = await imap.fetchVanishedSince(folderPath, Number(state.highestmodseq));
  }
  let vanished: FetchedImapFolder["vanished"];
  if (vanishedUids !== null) vanished = { kind: "uids", uids: vanishedUids };
  // Initial sync: nothing to diff against yet.
  else if (!state.uidvalidity) vanished = { kind: "uids", uids: [] };
  else vanished = { kind: "current", uids: await imap.fetchAllUids(folderPath) };

  return { snapshot, selection, uidvalidityChanged, sinceUid, batch, complete, changedFlags, vanished };
}

function sameFolderState(a: MailFolderSyncStateRow, b: MailFolderSyncStateRow): boolean {
  return a.uidvalidity === b.uidvalidity && a.uidnext === b.uidnext && a.highestmodseq === b.highestmodseq;
}

/**
 * Records every storage key a batch writes; when the batch's transaction fails they are deleted, best effort, since
 * no committed row references them. Keys of a committed batch are never deleted here.
 */
async function withBatchStorage<T>(
  storage: BlobStorageWriter,
  fn: (tracked: BlobStorageWriter) => Promise<T>,
): Promise<T> {
  const written = new Set<string>();
  const tracked: BlobStorageWriter = {
    async writeStream(storageKey, source, options) {
      // Recorded before the write: a mid-write failure (disk full) still leaves a partial file at this key.
      written.add(storageKey);
      return storage.writeStream(storageKey, source, options);
    },
    delete: (storageKey) => storage.delete(storageKey),
    readStream: (storageKey, range) => storage.readStream(storageKey, range),
  };
  try {
    return await fn(tracked);
  } catch (err) {
    const outcomes = await Promise.allSettled([...written].map((key) => storage.delete(key)));
    const failed = outcomes.filter((outcome) => outcome.status === "rejected").length;
    if (failed > 0) logger.warn({ failed }, "Deleting the attachment bytes of a failed mail sync batch failed");
    throw err;
  }
}

/**
 * The write half of a folder reconcile, in the caller's transaction under the mail-thread guard. The folder's sync
 * state row is locked and must still be the snapshot the fetch was computed from; otherwise another pass has moved
 * the folder on since, nothing is written and `null` is returned, so a cursor never moves backwards.
 */
async function applyImapFolder(
  dbClient: PoolClient,
  fetched: FetchedImapFolder,
  params: ReconcileImapFolderParams,
  relationDefinitionId: string,
): Promise<ReconcileImapFolderResult | null> {
  await lockMailThreadMutation(dbClient);
  const current = await lockMailFolderSyncState(dbClient, params.folderItemId);
  if (!current || !sameFolderState(current, fetched.snapshot)) return null;
  const protectedMoveMessageIds = await protectedMailMovesForPass(
    dbClient,
    params.mailboxItemId,
    params.moveBaseline,
    params.protectedMoveMessageIds,
  );
  if (fetched.uidvalidityChanged) {
    await resetForUidvalidityChange(dbClient, params.folderItemId, String(fetched.selection.uidvalidity));
  }

  for (const item of fetched.batch) {
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
      !protectedMoveMessageIds.has(result.itemId) &&
      !(await hasUnsettledMailMove(dbClient, result.itemId)) &&
      item.message.gmailLabels
    ) {
      await syncGmailLabelFolders(dbClient, params, relationDefinitionId, result.itemId, item.message.gmailLabels);
    }
  }

  for (const { uid, flags } of fetched.changedFlags) {
    if (uid >= fetched.sinceUid) continue; // already handled by the new-message loop above
    const emailItemId = await findEmailItemIdByFolderUid(dbClient, relationDefinitionId, params.folderItemId, uid);
    if (!emailItemId || protectedMoveMessageIds.has(emailItemId) || (await hasUnsettledMailMove(dbClient, emailItemId)))
      continue;
    await applyObservedMailMessageFlags(dbClient, {
      emailsDatabaseId: params.emailsDatabaseId,
      messageItemId: emailItemId,
      folderItemId: params.folderItemId,
      flags,
    });
  }

  let vanishedUids = fetched.vanished.uids;
  if (fetched.vanished.kind === "current") {
    const currentSet = new Set(fetched.vanished.uids);
    vanishedUids = (await listKnownFolderUids(dbClient, relationDefinitionId, params.folderItemId)).filter(
      (uid) => !currentSet.has(uid),
    );
  }
  for (const uid of vanishedUids) {
    const emailItemId = await findEmailItemIdByFolderUid(dbClient, relationDefinitionId, params.folderItemId, uid);
    if (
      emailItemId &&
      !protectedMoveMessageIds.has(emailItemId) &&
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
  const lastIngested = fetched.batch.at(-1);
  await recordReconcile(dbClient, {
    itemId: params.folderItemId,
    uidvalidity: String(fetched.selection.uidvalidity),
    uidnext: String(fetched.complete || !lastIngested ? fetched.selection.uidnext : lastIngested.uid + 1),
    highestmodseq: fetched.selection.highestModSeq !== null ? String(fetched.selection.highestModSeq) : null,
  });
  return { ingested: fetched.batch.length, complete: fetched.complete };
}

async function requireFolderRelationDefinitionId(
  client: PoolClient,
  folderRelationPropertyId: string,
): Promise<string> {
  const definition = await getRelationDefinitionByPropertyId(client, folderRelationPropertyId);
  if (!definition)
    throw new ValidationError(`Folder relation property ${folderRelationPropertyId} has no relation definition`);
  return definition.id;
}

/**
 * One folder on its own, outside an account pass: the provider fetch with no transaction open, then one write
 * transaction. A folder another pass moved on in between is left as that pass wrote it (`ingested: 0`, incomplete).
 */
export async function reconcileImapFolder(
  pool: Pool,
  imap: ImapMailClient,
  params: ReconcileImapFolderParams,
): Promise<ReconcileImapFolderResult> {
  const { snapshot, relationDefinitionId } = await withTransaction(pool, async (client) => {
    await lockMailThreadMutation(client);
    return {
      snapshot: await ensureMailFolderSyncState(client, params.folderItemId),
      relationDefinitionId: await requireFolderRelationDefinitionId(client, params.folderRelationPropertyId),
    };
  });
  const spool = createAttachmentSpool();
  try {
    const capabilities = await imap.getCapabilities();
    const fetched = await fetchImapFolder(
      imap,
      capabilities,
      params.folderPath,
      snapshot,
      params.maxNewMessages ?? IMAP_NEW_MESSAGES_PER_PASS,
      spool,
    );
    const result = await withBatchStorage(params.storage, (storage) =>
      withTransaction(pool, (client) => applyImapFolder(client, fetched, { ...params, storage }, relationDefinitionId)),
    );
    return result ?? { ingested: 0, complete: false };
  } finally {
    await spool.remove();
  }
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

/** How a pass enters and ends each of its transactions; supplied by the sync job. */
export interface ImapSyncPass {
  /**
   * Runs first in every transaction of the pass. `false` (the mailbox is gone, in the trash or has Mail switched off)
   * ends the pass with nothing more written.
   */
  enter(client: PoolClient): Promise<boolean>;
  /** Runs last in the pass's final transaction, after the account activity is recorded. */
  finish(client: PoolClient, result: { complete: boolean }): Promise<void>;
}

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
  pass: ImapSyncPass;
}

export interface ReconcileImapAccountResult {
  /** `false` when `pass.enter` ended the pass. */
  ran: boolean;
  /** `false` when new messages are left for a later pass, which `pass.finish` must schedule. */
  complete: boolean;
}

/** The inbox first, so a new account shows its current mail before the backfill of other folders. */
function inboxFirst(folders: ImapFolderRef[]): ImapFolderRef[] {
  const isInbox = (folder: ImapFolderRef) => folder.specialUse === "\\Inbox" || folder.path.toUpperCase() === "INBOX";
  return [...folders.filter(isInbox), ...folders.filter((folder) => !isInbox(folder))];
}

/** Every write transaction of a pass: `pass.enter` first, then the mail-thread guard. `null` when the pass ended. */
async function inPassTransaction<T>(
  pool: Pool,
  pass: ImapSyncPass,
  fn: (client: PoolClient) => Promise<T>,
): Promise<{ value: T } | null> {
  return withTransaction(pool, async (client) => {
    if (!(await pass.enter(client))) return null;
    await lockMailThreadMutation(client);
    return { value: await fn(client) };
  });
}

/**
 * One pass over an account. Nothing the provider is asked runs inside a transaction: the folder list, each folder's
 * selection and fetches (attachment bytes spooled to temp files) and the flag write-back happen between short
 * transactions, each of which re-enters the pass under the mailbox guard and the tenant's mail-thread guard. A prepare
 * transaction discovers Folder items and reads their sync state; each folder's batch is one write transaction; the
 * write-back's confirmations are another; a final one records the activity and calls `pass.finish`. A failure ends
 * the pass with the batches committed before it kept; recording it is the caller's job.
 */
export async function reconcileImapAccount(
  pool: Pool,
  imap: ImapMailClient,
  params: ReconcileImapAccountParams,
): Promise<ReconcileImapAccountResult> {
  const ended = { ran: false, complete: false };
  const capabilities = await imap.getCapabilities();
  const allFolders = await imap.listFolders();
  const folders = inboxFirst(
    params.folderPaths ? allFolders.filter((f) => params.folderPaths!.includes(f.path)) : allFolders,
  );

  const prepared = await inPassTransaction(pool, params.pass, async (client) => {
    await ensureMailAccountSyncState(client, { itemId: params.mailboxItemId, syncMode: "imap" });
    const [folderRelationDefinition, mailboxFolderRelationDefinition] = await Promise.all([
      getRelationDefinitionByPropertyId(client, params.folderRelationPropertyId),
      getRelationDefinitionByPropertyId(client, params.mailboxFolderRelationPropertyId),
    ]);
    if (!folderRelationDefinition || !mailboxFolderRelationDefinition) {
      throw new ValidationError("Mail folder relation definitions are missing from the email module schema");
    }
    const tracked: Array<{ folder: ImapFolderRef; folderItemId: string; snapshot: MailFolderSyncStateRow }> = [];
    for (const folder of folders) {
      const folderItemId = await ensureFolderItem(client, {
        foldersDatabaseId: params.foldersDatabaseId,
        mailboxItemId: params.mailboxItemId,
        mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
        providerId: folder.path,
        name: folder.path,
        behavior: "folder",
        specialPurpose: (folder.specialUse && SPECIAL_USE_TO_PURPOSE[folder.specialUse]) ?? "none",
      });
      tracked.push({ folder, folderItemId, snapshot: await ensureMailFolderSyncState(client, folderItemId) });
    }
    return {
      folders: tracked,
      folderRelationDefinitionId: folderRelationDefinition.id,
      mailboxFolderRelationDefinitionId: mailboxFolderRelationDefinition.id,
    };
  });
  if (!prepared) return ended;
  const { folderRelationDefinitionId, mailboxFolderRelationDefinitionId } = prepared.value;

  let budget = IMAP_NEW_MESSAGES_PER_PASS;
  let complete = true;
  const spool = createAttachmentSpool();
  try {
    for (const { folder, folderItemId, snapshot } of prepared.value.folders) {
      if (budget === 0) {
        complete = false;
        continue;
      }
      const fetched = await fetchImapFolder(imap, capabilities, folder.path, snapshot, budget, spool);
      const folderParams: ReconcileImapFolderParams = {
        folderItemId,
        folderPath: folder.path,
        protectedMoveMessageIds: params.protectedMoveMessageIds,
        moveBaseline: params.moveBaseline,
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
      };
      const written = await withBatchStorage(params.storage, (storage) =>
        inPassTransaction(pool, params.pass, (client) =>
          applyImapFolder(client, fetched, { ...folderParams, storage }, folderRelationDefinitionId),
        ),
      );
      if (!written) return ended;
      // Another pass moved this folder on since its state was read: this pass stops and leaves the rest to a later one.
      if (!written.value) {
        complete = false;
        break;
      }
      budget -= written.value.ingested;
      if (!written.value.complete) complete = false;
    }
  } finally {
    await spool.remove();
  }

  // Rows only exist where observed != desired, so provider changes are not echoed back.
  const pending = await inPassTransaction(pool, params.pass, async (client) => {
    const protectedMoveMessageIds = await protectedMailMovesForPass(
      client,
      params.mailboxItemId,
      params.moveBaseline,
      params.protectedMoveMessageIds,
    );
    const writes = await listPendingImapFlagWrites(client, {
      folderRelationDefinitionId,
      mailboxFolderRelationDefinitionId,
      mailboxItemId: params.mailboxItemId,
    });
    const pendingByFlag = new Map<string, PendingImapFlagWrite[]>();
    for (const write of writes) {
      if (protectedMoveMessageIds.has(write.messageItemId) || (await hasUnsettledMailMove(client, write.messageItemId)))
        continue;
      const key = `${write.messageItemId}:${write.propertyKey}`;
      const group = pendingByFlag.get(key) ?? [];
      group.push(write);
      pendingByFlag.set(key, group);
    }
    return [...pendingByFlag.values()];
  });
  if (!pending) return ended;
  const writeback = createImapMailFlagWritebackAdapter(imap);
  const confirmed: PendingImapFlagWrite[] = [];
  for (const writes of pending.value) {
    let allApplied = true;
    for (const write of writes) {
      if ((await writeback.write(write)) !== "applied") allApplied = false;
    }
    if (allApplied && writes[0]) confirmed.push(writes[0]);
  }

  // The confirmation stores what the provider now holds; a desired state changed since stays pending.
  const finished = await inPassTransaction(pool, params.pass, async (client) => {
    for (const write of confirmed) {
      await recordConfirmedMailMessageFlag(client, write.messageItemId, write.propertyKey, write.desiredState);
    }
    // Periodic reconcile is the only mechanism here; IDLE just triggers it earlier. An unfinished backfill is due at
    // once, so the sweep resumes it even if the follow-up job is lost.
    await recordImapActivity(client, {
      itemId: params.mailboxItemId,
      nextExpectedActivityAt: complete ? new Date(Date.now() + 30 * 60 * 1000) : new Date(),
      completesInitialSync: complete,
    });
    await params.pass.finish(client, { complete });
  });
  if (!finished) return ended;
  return { ran: true, complete };
}
