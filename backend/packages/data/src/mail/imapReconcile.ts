import type { PoolClient } from "pg";
import { deleteRelationWithClient } from "../chokePoint/chokePoint.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import { ValidationError } from "../errors.js";
import { ingestEmailMessage } from "./ingest.js";
import type { FetchedMessage } from "./providerTypes.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import { ensureMailFolderSyncState, getMailFolderSyncState, recordReconcile, resetForUidvalidityChange } from "./mailFolderSyncStateStore.js";
import { findEmailItemIdByFolderUid, listKnownFolderUids, updateFolderEdgeFlags } from "./folderMembershipStore.js";
import { ensureFolderItem } from "./folderDiscovery.js";
import { ensureMailAccountSyncState, recordImapActivity } from "./mailAccountSyncStateStore.js";

export interface ImapFetchedMessage {
  uid: number;
  message: FetchedMessage;
  /**
   * The message's current IMAP flags at fetch time — captured on every `fetchMessagesSince`
   * call (initial sync AND every incremental pass' new messages), not only via the separate
   * `fetchFlagsChangedSince` pass. Without this, a message's flags at the moment it's first
   * ingested were never recorded at all (only later *changes* would be, via CHANGEDSINCE) —
   * most visibly after a UIDVALIDITY reset, where the full-resync path re-ingests every
   * message through here and `highestmodseq` is reset to NULL, so the CHANGEDSINCE pass has
   * nothing to diff against and pre-existing flags (e.g. `\Seen`) would otherwise be silently
   * dropped.
   */
  flags: string[];
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

export interface ImapFlagChange {
  uid: number;
  flags: string[];
}

export interface ImapMailClient {
  getCapabilities(): Promise<Set<string>>;
  listFolders(): Promise<ImapFolderRef[]>;
  selectFolder(path: string): Promise<ImapFolderSelection>;
  /**
   * Every message with UID >= `sinceUid` — used both for the initial full sync (`sinceUid: 1`)
   * and every incremental pass. An async iterable, not a pre-collected array: a large initial
   * sync can have thousands of messages, each with its own body text/html buffer (see
   * imapFlowClient.ts's `MAX_BODY_TEXT_BYTES`) — collecting them all before the caller
   * processes any would hold every one of those buffers in memory simultaneously. Yielding
   * one at a time lets `reconcileImapFolder` ingest (and let the GC reclaim) each message
   * before the next is even fetched.
   */
  fetchMessagesSince(path: string, sinceUid: number): AsyncIterable<ImapFetchedMessage>;
  /** QRESYNC `VANISHED` since the given MODSEQ; `null` when the server doesn't support QRESYNC (caller falls back to `fetchAllUids`). */
  fetchVanishedSince(path: string, sinceModSeq: number): Promise<number[] | null>;
  /** Every UID currently in the folder — the no-QRESYNC deletion-detection fallback (a full UID diff against what this folder's edges already know, see folderMembershipStore.ts). */
  fetchAllUids(path: string): Promise<number[]>;
  /** `UID FETCH ... CHANGEDSINCE <modseq> (FLAGS)` (issue #26) — flag-only changes (e.g. read elsewhere) on messages this folder already knows about, not just new arrivals. CONDSTORE-only servers support this without full QRESYNC. */
  fetchFlagsChangedSince(path: string, sinceModSeq: number): Promise<ImapFlagChange[]>;
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
  for await (const item of imap.fetchMessagesSince(params.folderPath, sinceUid)) {
    await ingestEmailMessage(dbClient, {
      emailsDatabaseId: params.emailsDatabaseId,
      filesDatabaseId: params.filesDatabaseId,
      folderRelationPropertyId: params.folderRelationPropertyId,
      attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
      folderItemId: params.folderItemId,
      folderUid: item.uid,
      folderFlags: item.flags,
      storage: params.storage,
      storageKeyPrefix: params.storageKeyPrefix,
      ...item.message,
    });
  }

  // CONDSTORE-only servers (no QRESYNC) still support CHANGEDSINCE(FLAGS) — this is
  // deliberately gated on CONDSTORE alone, not folded into the QRESYNC-only VANISHED check
  // below, since the two extensions are supported independently (issue #26: "Not all servers
  // support this... generic IMAP without CONDSTORE falls back to a full reconcile").
  if (capabilities.has("CONDSTORE") && state.highestmodseq) {
    const changedFlags = await imap.fetchFlagsChangedSince(params.folderPath, Number(state.highestmodseq));
    for (const change of changedFlags) {
      await updateFolderEdgeFlags(dbClient, relationDefinition.id, params.folderItemId, change.uid, change.flags);
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
  /** Gmail/Outlook in IMAP fallback mode (issue #26): sync only `[Gmail]/All Mail` (or the equivalent `\All` folder) instead of every folder, deriving label membership from `X-GM-LABELS` — not implemented by this reconcile pass; `folderPaths` lets the composition root pass exactly `["[Gmail]/All Mail"]` for that mode. Defaults to every folder the server lists, correct for iCloud/generic IMAP (this adapter's actual default target). */
  folderPaths?: string[];
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
    });
  }

  // IMAP has no push-vs-poll distinction at this layer — periodic reconcile is the only
  // mechanism (IDLE, when used, just triggers this same pass earlier); a fixed 30-minute
  // horizon is within the issue's stated 15-60 minute reconcile window.
  await recordImapActivity(dbClient, { itemId: params.mailboxItemId, nextExpectedActivityAt: new Date(Date.now() + 30 * 60 * 1000) });
}
