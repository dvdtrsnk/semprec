import type { Pool, PoolClient } from "pg";
import { hasUnsettledMailMove, protectedMailMovesForPass, type MailMoveBaseline } from "./mailMessageMoveSyncStore.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { ingestEmailMessage, type IngestedMailContent } from "./ingest.js";
import type { FetchedMessage } from "./providerTypes.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import type { ClassifiedAttachment, IndexedAttachment } from "./attachments.js";
import {
  ensureMailFolderSyncState,
  lockMailFolderSyncState,
  recordBackfill,
  recordReconcile,
  resetForUidvalidityChange,
  type MailFolderSyncStateRow,
} from "./mailFolderSyncStateStore.js";
import { findEmailItemIdByFolderUid, listKnownFolderUids } from "./folderMembershipStore.js";
import { ensureFolderItem, type ProviderFolder } from "./folderDiscovery.js";
import {
  anchorMailAccountConnection,
  ensureMailAccountSyncState,
  recordImapActivity,
} from "./mailAccountSyncStateStore.js";
import { mailArrivalOf, type MailArrival } from "./mailArrival.js";
import { mailContentStateOf, type MailContentState } from "./mailContentState.js";
import {
  clearMailMessageFolderCopyRemoved,
  deleteMailMessageMetaOfRemovedItem,
  getMailMessageMetaByMailboxAndMessageId,
  listKnownMailMessageIds,
  listMailMessagesWithFolderCopyRemoved,
  markMailMessageFolderCopyRemoved,
} from "./mailMessageMetaStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import {
  listPendingImapFlagWrites,
  recordConfirmedMailMessageFlag,
  type PendingImapFlagWrite,
} from "./mailMessageFlagSyncStore.js";
import { createImapMailFlagWritebackAdapter } from "./mailFlagWriteback.js";
import { applyObservedMailMessageFlags } from "./mailFlagObservation.js";
import { createAttachmentSpool, type AttachmentSpool } from "./mailAttachmentSpool.js";
import { inPassTransaction, withBatchStorage, type MailSyncPass, type MailSyncPassResult } from "./mailSyncPass.js";
import type { ImapMailClient } from "./imapMailClient.js";
export type { ImapMailClient, ImapMessageBody } from "./imapMailClient.js";

/** A message as the light fetch gives it: envelope, threading and delivery headers, flags and labels, no body. */
export type ImapMessageEnvelope = Omit<FetchedMessage, "bodyText" | "bodyHtml" | "attachments">;

/** The part an index message's snippet is read from (the plain-text part, else the HTML part), per BODYSTRUCTURE. */
export interface ImapSnippetPart {
  /** The body section: a part number, or `TEXT` for a single-part message. */
  section: string;
  /** The part's Content-Transfer-Encoding, lowercased; absent means none. */
  encoding?: string;
  charset?: string;
  html: boolean;
}

/** A full message's body parts, and its attachments with their byte streams. */
export interface ImapMessageContent {
  bodyText?: string;
  bodyHtml?: string;
  attachments: ClassifiedAttachment[];
}

export interface ImapFetchedMessage {
  uid: number;
  message: ImapMessageEnvelope;
  /** The attachments BODYSTRUCTURE lists, as an index message records them; no byte of them is fetched. */
  attachments: IndexedAttachment[];
  snippetPart?: ImapSnippetPart;
  /** Downloads the body parts and opens the attachment streams of a full message; called at most once. */
  fetchContent(): Promise<ImapMessageContent>;
}

export interface ImapFolderSelection {
  uidvalidity: number;
  uidnext: number;
  /** null = no CONDSTORE. */
  highestModSeq: number | null;
  /** How many messages the folder holds (`EXISTS`, or `MESSAGES` of a STATUS). */
  messages: number;
}

export interface ImapFolderRef {
  path: string;
  /** RFC 6154 special-use attribute, when advertised. */
  specialUse?: string;
  /** The folder's STATUS, listed with it; absent when the client did not ask for it or the server gave none. */
  status?: ImapFolderSelection;
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
}

/**
 * Full messages (live mail, and history within the full-content window) one pass ingests across all folders of an
 * account: each costs its body parts and its attachments' bytes.
 */
export const IMAP_FULL_MESSAGES_PER_PASS = 25;
/** Index messages one pass ingests, and messages whose Message-ID the mailbox holds: each costs a few octets. */
export const IMAP_INDEX_MESSAGES_PER_PASS = 500;
/** Messages one write transaction ingests, which bounds how long a batch holds the tenant's mail-thread guard. */
export const IMAP_MESSAGES_PER_BATCH = 50;

export interface ReconcileImapFolderResult {
  ingested: number;
  /** `false` when new messages or backfill are left for a later pass. */
  complete: boolean;
}

/** What is left of a pass's budget; spent as messages are taken into batches. */
interface ImapPassBudget {
  full: number;
  index: number;
}

/** A message ready to be written: its arrival and content decided, its content downloaded and spooled. */
interface PreparedImapMessage {
  uid: number;
  message: ImapMessageEnvelope;
  arrival: MailArrival;
  /** `null`: the mailbox held its Message-ID when the batch was prepared, so none of its content was fetched. */
  content: IngestedMailContent | null;
  /** Its Date lies before the full-content window, whatever the mailbox already held of it. */
  olderThanWindow: boolean;
}

/** What every fetch and write of one pass shares. */
interface ImapPassContext {
  pool: Pool;
  imap: ImapMailClient;
  capabilities: Set<string>;
  params: ReconcileImapFolderParams;
  relationDefinitionId: string;
  connectedAt: Date;
  budget: ImapPassBudget;
  spool: AttachmentSpool;
  /** Message-IDs taken into a batch earlier in the pass; a later copy is ingested as a known message. */
  takenMessageIds: Set<string>;
  /** One write transaction; `null` when the pass ended. A failed batch deletes the attachment bytes it wrote. */
  write<T>(fn: (client: PoolClient, storage: BlobStorageWriter) => Promise<T>): Promise<{ value: T } | null>;
}

/**
 * Takes `candidates` in order while the budget lasts, then fetches what each needs, with no transaction open: a full
 * message its body parts and attachment bytes (spooled), an index message its snippet, one whose Message-ID the
 * mailbox already holds nothing. `exhausted` tells that the budget stopped the batch before its end.
 */
async function prepareImapBatch(
  ctx: ImapPassContext,
  path: string,
  liveFromUid: number,
  candidates: readonly ImapFetchedMessage[],
): Promise<{ prepared: PreparedImapMessage[]; exhausted: boolean }> {
  if (candidates.length === 0) return { prepared: [], exhausted: false };
  const known = await withTransaction(ctx.pool, (client) =>
    listKnownMailMessageIds(
      client,
      ctx.params.mailboxItemId,
      candidates.map((candidate) => candidate.message.messageId),
    ),
  );
  const taken: Array<{ candidate: ImapFetchedMessage; arrival: MailArrival; state: MailContentState | null }> = [];
  let exhausted = false;
  for (const candidate of candidates) {
    const { messageId, date } = candidate.message;
    const arrival = mailArrivalOf({ reportedNew: candidate.uid >= liveFromUid, date, connectedAt: ctx.connectedAt });
    const state =
      known.has(messageId) || ctx.takenMessageIds.has(messageId)
        ? null
        : mailContentStateOf({ arrival, date, connectedAt: ctx.connectedAt });
    const cost = state === "full" ? "full" : "index";
    if (ctx.budget[cost] === 0) {
      exhausted = true;
      break;
    }
    ctx.budget[cost]--;
    ctx.takenMessageIds.add(messageId);
    taken.push({ candidate, arrival, state });
  }
  const snippetRequests = taken.flatMap(({ candidate, state }) =>
    state === "index" && candidate.snippetPart ? [{ uid: candidate.uid, part: candidate.snippetPart }] : [],
  );
  const snippets =
    snippetRequests.length > 0 ? await ctx.imap.fetchSnippets(path, snippetRequests) : new Map<number, string>();
  const prepared: PreparedImapMessage[] = [];
  for (const { candidate, arrival, state } of taken) {
    let content: IngestedMailContent | null = null;
    if (state === "full") {
      const { attachments, ...bodies } = await candidate.fetchContent();
      content = { contentState: "full", ...bodies, attachments: await ctx.spool.spool(attachments) };
    } else if (state === "index") {
      const snippet = snippets.get(candidate.uid);
      content = {
        contentState: "index",
        ...(snippet !== undefined ? { snippet } : {}),
        attachments: candidate.attachments,
      };
    }
    const { date } = candidate.message;
    const olderThanWindow =
      date !== undefined && mailContentStateOf({ arrival, date, connectedAt: ctx.connectedAt }) === "index";
    prepared.push({ uid: candidate.uid, message: candidate.message, arrival, content, olderThanWindow });
  }
  return { prepared, exhausted };
}

/**
 * Ingests `batch` in order and returns how many it wrote. A message prepared as known whose Message-ID the mailbox no
 * longer holds (removed since) ends the batch there, unwritten, so a later pass fetches its content.
 */
async function ingestImapBatch(
  dbClient: PoolClient,
  params: ReconcileImapFolderParams,
  relationDefinitionId: string,
  protectedMoveMessageIds: ReadonlySet<string>,
  batch: readonly PreparedImapMessage[],
): Promise<number> {
  for (const [position, item] of batch.entries()) {
    if (
      item.content === null &&
      !(await getMailMessageMetaByMailboxAndMessageId(dbClient, params.mailboxItemId, item.message.messageId))
    )
      return position;
    const result = await ingestEmailMessage(dbClient, {
      arrival: item.arrival,
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
      // A known message converges onto the stored one, which keeps its own content.
      ...(item.content ?? { contentState: "index", attachments: [] }),
    });

    if (
      !protectedMoveMessageIds.has(result.itemId) &&
      !(await hasUnsettledMailMove(dbClient, result.itemId)) &&
      item.message.gmailLabels
    ) {
      await syncGmailLabelFolders(dbClient, params, relationDefinitionId, result.itemId, item.message.gmailLabels);
    }
  }
  return batch.length;
}

const GMAIL_LABEL_TO_PURPOSE: Record<string, string> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Spam": "junk",
  "\\Trash": "trash",
  "\\Draft": "drafts",
  "\\All": "all",
};

/** A listed IMAP folder as its Folder item: named by its path, its purpose from its RFC 6154 special-use attribute. */
export function imapProviderFolder(folder: ImapFolderRef): ProviderFolder {
  return {
    providerId: folder.path,
    name: folder.path,
    behavior: "folder",
    specialPurpose: (folder.specialUse && SPECIAL_USE_TO_PURPOSE[folder.specialUse]) ?? "none",
  };
}

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
  /** The selection's `UIDVALIDITY` differs from the stored one, so the folder's state is established anew. */
  uidvalidityChanged: boolean;
  /** The state is established by this write: the folder's first, or the first after a UIDVALIDITY change. */
  establishes: boolean;
  /** A UID at or above it is reported new: the selected UIDNEXT when the state is established now. */
  liveFromUid: number;
  sinceUid: number;
  batch: PreparedImapMessage[];
  /** Every UID at or above `sinceUid` is in `batch`. */
  complete: boolean;
  changedFlags: Array<{ uid: number; flags: string[] }>;
  /** Vanished UIDs, or every UID the folder holds now, diffed against the known ones on write. */
  vanished: { kind: "uids"; uids: number[] } | { kind: "current"; uids: number[] };
}

/**
 * The provider half of a folder's live reconcile, with no transaction open: the messages from the live cursor up
 * (lowest UIDs first, while the budget lasts), changed flags and vanished UIDs. A folder whose state is established
 * now starts its live cursor at the selected UIDNEXT, leaving every message it holds to the backfill. A changed
 * `UIDVALIDITY` invalidates the UID cache, so the cursors come from the reset state; QRESYNC/CONDSTORE support is
 * checked per pass, not stored.
 */
async function fetchImapFolder(
  ctx: ImapPassContext,
  folderPath: string,
  snapshot: MailFolderSyncStateRow,
): Promise<FetchedImapFolder> {
  const { imap, capabilities, budget } = ctx;
  const selection = await imap.selectFolder(folderPath);
  const uidvalidityChanged = snapshot.uidvalidity !== null && snapshot.uidvalidity !== String(selection.uidvalidity);
  const state = uidvalidityChanged
    ? { uidvalidity: String(selection.uidvalidity), uidnext: null, highestmodseq: null }
    : snapshot;
  const establishes = uidvalidityChanged || snapshot.liveFromUid === null;
  const liveFromUid = establishes ? selection.uidnext : Number(snapshot.liveFromUid);

  const sinceUid = establishes || state.uidnext === null ? selection.uidnext : Number(state.uidnext);
  // No UID at or above the cursor exists while UIDNEXT has not moved past it.
  const noNewUids =
    establishes || (Number.isSafeInteger(selection.uidnext) && selection.uidnext > 0 && selection.uidnext <= sinceUid);
  const limit = Math.min(budget.full + budget.index, IMAP_MESSAGES_PER_BATCH);
  // One more than the limit tells whether messages remain above this batch.
  const fetched =
    noNewUids || limit === 0
      ? []
      : (await imap.fetchMessagesSince(folderPath, sinceUid, limit + 1)).sort((a, b) => a.uid - b.uid);
  // How many UIDs the folder holds at or above sinceUid, when the fetch saw every one of them.
  const newUids = noNewUids ? 0 : limit > 0 && fetched.length <= limit ? fetched.length : null;
  const { prepared: batch, exhausted } = await prepareImapBatch(ctx, folderPath, liveFromUid, fetched.slice(0, limit));
  const complete = newUids !== null && !exhausted;

  // Under CONDSTORE every flag change raises HIGHESTMODSEQ, so with it as stored no known UID changed its flags.
  const flagsUnchanged =
    !uidvalidityChanged &&
    capabilities.has("CONDSTORE") &&
    selection.highestModSeq !== null &&
    state.highestmodseq === String(selection.highestModSeq);
  // UIDs only grow, so with UIDNEXT as stored nothing was added, and with the count as stored nothing left either.
  const nothingVanished =
    !uidvalidityChanged &&
    state.uidnext === String(selection.uidnext) &&
    snapshot.messageCount === String(selection.messages);

  const fetchedFolder = {
    snapshot,
    selection,
    uidvalidityChanged,
    establishes,
    liveFromUid,
    sinceUid,
    batch,
    complete,
  };
  // Skipped on a folder's first sync, which ingests nothing yet: no known message can have changed or vanished.
  if (!state.uidvalidity) {
    return { ...fetchedFolder, changedFlags: [], vanished: { kind: "uids", uids: [] } };
  }

  // UIDs below sinceUid are never re-fetched, so their flags are refreshed here; under QRESYNC the same fetch reports
  // the UIDs expunged since the stored mod-sequence.
  const sinceModSeq = capabilities.has("CONDSTORE") && state.highestmodseq ? Number(state.highestmodseq) : null;
  let changedFlags: Array<{ uid: number; flags: string[] }> = [];
  let reportedVanished: number[] | null = null;
  if (capabilities.has("QRESYNC") && sinceModSeq !== null && !(flagsUnchanged && nothingVanished)) {
    const changes = await imap.fetchChangesSince(folderPath, sinceModSeq);
    if (changes) {
      changedFlags = changes.flags;
      reportedVanished = changes.vanished;
    }
  }
  if (reportedVanished === null && !flagsUnchanged) {
    changedFlags = await imap.fetchFlagsChangedSince(folderPath, sinceModSeq);
  }

  // The known UIDs are those ingested so far, a subset of the folder while its backfill runs; both checks below
  // compare server counts and diff only against the known UIDs, so a UID not backfilled yet is never removed.
  let vanished: FetchedImapFolder["vanished"];
  if (nothingVanished) vanished = { kind: "uids", uids: reportedVanished ?? [] };
  else if (countAccountsForFolder(snapshot, selection, sinceUid, newUids, reportedVanished))
    vanished = { kind: "uids", uids: reportedVanished ?? [] };
  else vanished = { kind: "current", uids: await imap.fetchAllUids(folderPath) };

  return { ...fetchedFolder, changedFlags, vanished };
}

/**
 * The stored count described the folder at the stored UIDNEXT (`sinceUid`). When it, less the reported vanished UIDs
 * below `sinceUid` and plus the new UIDs found at or above it, equals the selected count, the reported vanished UIDs
 * are every UID that left (none without QRESYNC). A removal could only balance against an unseen addition below
 * `sinceUid`, which IMAP excludes (UIDs only grow), so a `true` never hides a removal. A fetch that did not see every
 * new UID (`newUids` null), a changed UIDVALIDITY or an unknown stored count gives `false`, and the caller diffs every
 * UID.
 */
function countAccountsForFolder(
  snapshot: MailFolderSyncStateRow,
  selection: ImapFolderSelection,
  sinceUid: number,
  newUids: number | null,
  reportedVanished: number[] | null,
): boolean {
  if (newUids === null || snapshot.messageCount === null || snapshot.uidvalidity !== String(selection.uidvalidity))
    return false;
  const vanishedBelow = new Set((reportedVanished ?? []).filter((uid) => uid < sinceUid)).size;
  return Number(snapshot.messageCount) - vanishedBelow + newUids === selection.messages;
}

/**
 * The cursors a live step reads and writes. The backfill cursor is not among them: the live step keeps the stored one
 * (it sets it only when it establishes the state), so a backfill slice committed meanwhile, the server's or a native
 * client's, does not overtake it.
 */
function sameLiveCursors(a: MailFolderSyncStateRow, b: MailFolderSyncStateRow): boolean {
  return (
    a.uidvalidity === b.uidvalidity &&
    a.uidnext === b.uidnext &&
    a.highestmodseq === b.highestmodseq &&
    a.messageCount === b.messageCount &&
    a.liveFromUid === b.liveFromUid
  );
}

function sameFolderState(a: MailFolderSyncStateRow, b: MailFolderSyncStateRow): boolean {
  return sameLiveCursors(a, b) && a.backfillBelowUid === b.backfillBelowUid;
}

/**
 * The listed STATUS equals every stored cursor, so the folder holds nothing new, nothing vanished and no changed flag.
 * Without a mod-sequence a flag change would not show, so such a folder never counts as unchanged. It tells nothing of
 * the backfill, which runs below the cursors whatever the STATUS says.
 */
function unchangedSinceLastReconcile(snapshot: MailFolderSyncStateRow, status: ImapFolderSelection): boolean {
  return (
    status.highestModSeq !== null &&
    snapshot.highestmodseq === String(status.highestModSeq) &&
    snapshot.uidvalidity === String(status.uidvalidity) &&
    snapshot.uidnext === String(status.uidnext) &&
    snapshot.messageCount === String(status.messages)
  );
}

/** A folder write's outcome inside a pass: the state it left, what it ingested and the copies that vanished. */
interface AppliedImapFolder {
  state: MailFolderSyncStateRow;
  ingested: number;
  /** `false` when new messages above the last ingested UID are left for a later pass. */
  complete: boolean;
  copiesRemovedFrom: string[];
}

/**
 * The write half of a folder's live reconcile, in the caller's transaction under the mail-thread guard. The folder's
 * sync state row is locked and its live cursors must still be the snapshot's the fetch was computed from; otherwise
 * another pass has moved the folder on since, nothing is written and `null` is returned, so a cursor never moves
 * backwards.
 *
 * A folder whose state is first established, or reset by a UIDVALIDITY change, takes the selected UIDNEXT as its
 * `live_from_uid`, its live cursor and its `backfill_below_uid`: every message already in it is backfill, and only a
 * UID at or above it is reported as new. A folder whose UIDNEXT is 1 never held a message, so it has no backfill.
 */
async function applyImapFolder(
  dbClient: PoolClient,
  fetched: FetchedImapFolder,
  params: ReconcileImapFolderParams,
  relationDefinitionId: string,
): Promise<AppliedImapFolder | null> {
  await lockMailThreadMutation(dbClient);
  const current = await lockMailFolderSyncState(dbClient, params.folderItemId);
  if (!current || !sameLiveCursors(current, fetched.snapshot)) return null;
  const protectedMoveMessageIds = await protectedMailMovesForPass(
    dbClient,
    params.mailboxItemId,
    params.moveBaseline,
    params.protectedMoveMessageIds,
  );
  if (fetched.uidvalidityChanged) {
    await resetForUidvalidityChange(dbClient, params.folderItemId, String(fetched.selection.uidvalidity));
  }
  const ingested = await ingestImapBatch(
    dbClient,
    params,
    relationDefinitionId,
    protectedMoveMessageIds,
    fetched.batch,
  );
  const complete = fetched.complete && ingested === fetched.batch.length;

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
  const copiesRemovedFrom: string[] = [];
  for (const uid of vanishedUids) {
    const emailItemId = await findEmailItemIdByFolderUid(dbClient, relationDefinitionId, params.folderItemId, uid);
    if (
      emailItemId &&
      !protectedMoveMessageIds.has(emailItemId) &&
      !(await hasUnsettledMailMove(dbClient, emailItemId))
    ) {
      copiesRemovedFrom.push(emailItemId);
      await deleteRelationWithClient(
        dbClient,
        {
          relationPropertyId: params.folderRelationPropertyId,
          callerItemId: emailItemId,
          targetItemId: params.folderItemId,
        },
        EMAILS_RELATION_CONTEXT,
      );
      // Committed with the edge's removal, so a pass that ends before its final transaction leaves the Email to the
      // next pass's decision instead of without any folder edge for good.
      await markMailMessageFolderCopyRemoved(dbClient, emailItemId);
    }
  }

  // A partial batch resumes after its last ingested UID. The modseq read at selection still bounds the flag and
  // vanish checks of the next pass: changes after it have a higher modseq.
  const lastIngested = fetched.batch[ingested - 1];
  const { selection } = fetched;
  const state = await recordReconcile(dbClient, {
    itemId: params.folderItemId,
    uidvalidity: String(selection.uidvalidity),
    uidnext: String(complete ? selection.uidnext : lastIngested ? lastIngested.uid + 1 : fetched.sinceUid),
    highestmodseq: selection.highestModSeq !== null ? String(selection.highestModSeq) : null,
    messageCount: String(selection.messages),
    liveFromUid: String(fetched.liveFromUid),
    backfillBelowUid: fetched.establishes
      ? selection.uidnext > 1
        ? String(selection.uidnext)
        : null
      : current.backfillBelowUid,
  });
  return { state, ingested, complete, copiesRemovedFrom };
}

/** How a backfill batch's write ended. */
type AppliedImapBackfill =
  | { kind: "written"; state: MailFolderSyncStateRow; ingested: number }
  /** Another pass or a native client's upload moved the folder on since the batch's fetch. */
  | { kind: "overtaken" }
  /** A native client took a lease on the folder's backfill since the batch's fetch. */
  | { kind: "leased" };

/**
 * The write of one backfill batch, in the caller's transaction under the mail-thread guard. The folder's sync state row
 * is locked and must still hold the cursors the batch's fetch started from and no client lease; otherwise nothing is
 * written. `backfill_below_uid` moves down to the lowest UID written; after the folder's last batch (`last`, every UID
 * below the cursor written) it becomes `null`. A batch that writes a message dated before the full-content window marks
 * the folder index-only.
 */
async function applyImapBackfill(
  dbClient: PoolClient,
  expected: MailFolderSyncStateRow,
  batch: readonly PreparedImapMessage[],
  last: boolean,
  params: ReconcileImapFolderParams,
  relationDefinitionId: string,
): Promise<AppliedImapBackfill> {
  await lockMailThreadMutation(dbClient);
  const current = await lockMailFolderSyncState(dbClient, params.folderItemId);
  if (!current || !sameFolderState(current, expected)) return { kind: "overtaken" };
  if (current.clientBackfillLease !== null) return { kind: "leased" };
  const protectedMoveMessageIds = await protectedMailMovesForPass(
    dbClient,
    params.mailboxItemId,
    params.moveBaseline,
    params.protectedMoveMessageIds,
  );
  const ingested = await ingestImapBatch(dbClient, params, relationDefinitionId, protectedMoveMessageIds, batch);
  const lowestIngested = batch[ingested - 1];
  const backfillBelowUid =
    last && ingested === batch.length ? null : lowestIngested ? String(lowestIngested.uid) : current.backfillBelowUid;
  const indexOnly = batch.slice(0, ingested).some((message) => message.olderThanWindow);
  return {
    kind: "written",
    state: await recordBackfill(dbClient, params.folderItemId, backfillBelowUid, { indexOnly }),
    ingested,
  };
}

/**
 * How a folder's step of a pass ended: the pass ended, another pass overtook the folder, a native client holds the
 * folder's backfill (backfill step only), or the state it left.
 */
type ImapFolderStep =
  | { kind: "ended" }
  | { kind: "overtaken" }
  | { kind: "leased" }
  | {
      kind: "written";
      state: MailFolderSyncStateRow;
      ingested: number;
      complete: boolean;
      copiesRemovedFrom: string[];
    };

/** The live step of one folder: new messages, changed flags and vanished UIDs, in one write transaction. */
async function syncImapFolderLive(
  ctx: ImapPassContext,
  folderPath: string,
  snapshot: MailFolderSyncStateRow,
): Promise<Exclude<ImapFolderStep, { kind: "leased" }>> {
  const fetched = await fetchImapFolder(ctx, folderPath, snapshot);
  const written = await ctx.write((client, storage) =>
    applyImapFolder(client, fetched, { ...ctx.params, storage }, ctx.relationDefinitionId),
  );
  if (!written) return { kind: "ended" };
  if (!written.value) return { kind: "overtaken" };
  return { kind: "written", ...written.value };
}

/**
 * The backfill step of one folder: from `backfill_below_uid` downwards (highest UIDs first) while the budget lasts,
 * in write transactions of at most `IMAP_MESSAGES_PER_BATCH` messages, each moving the cursor down once it commits.
 * A UIDVALIDITY changed since the live step leaves the folder to the next pass, which establishes it anew. A folder
 * whose backfill a native client holds under a lease is left to it, without a SELECT.
 */
async function backfillImapFolder(
  ctx: ImapPassContext,
  folderPath: string,
  snapshot: MailFolderSyncStateRow,
): Promise<ImapFolderStep> {
  const unchanged: ImapFolderStep = {
    kind: "written",
    state: snapshot,
    ingested: 0,
    complete: false,
    copiesRemovedFrom: [],
  };
  const limit = ctx.budget.full + ctx.budget.index;
  if (snapshot.backfillBelowUid === null || snapshot.liveFromUid === null || limit === 0) return unchanged;
  if (snapshot.clientBackfillLease !== null) return { kind: "leased" };
  const selection = await ctx.imap.selectFolder(folderPath);
  if (String(selection.uidvalidity) !== snapshot.uidvalidity) return unchanged;
  const liveFromUid = Number(snapshot.liveFromUid);
  const fetched = await ctx.imap.fetchMessagesBefore(folderPath, Number(snapshot.backfillBelowUid), limit + 1);
  const candidates = fetched.slice(0, limit);
  const more = fetched.length > limit;

  let state = snapshot;
  let ingested = 0;
  for (let offset = 0; ;) {
    const { prepared, exhausted } = await prepareImapBatch(
      ctx,
      folderPath,
      liveFromUid,
      candidates.slice(offset, offset + IMAP_MESSAGES_PER_BATCH),
    );
    const last = !more && !exhausted && offset + prepared.length === candidates.length;
    if (prepared.length === 0 && !last) break;
    const expected = state;
    const written = await ctx.write((client, storage) =>
      applyImapBackfill(client, expected, prepared, last, { ...ctx.params, storage }, ctx.relationDefinitionId),
    );
    if (!written) return { kind: "ended" };
    if (written.value.kind !== "written") return written.value;
    state = written.value.state;
    ingested += written.value.ingested;
    offset += prepared.length;
    if (last || exhausted || written.value.ingested < prepared.length) break;
  }
  return { kind: "written", state, ingested, complete: state.backfillBelowUid === null, copiesRemovedFrom: [] };
}

/**
 * Decides each of `emailItemIds` and each Email of the mailbox an earlier pass marked
 * (`markMailMessageFolderCopyRemoved`) and left undecided because it ended early. One with no folder edge left and no
 * move in flight is trashed as the system writer and loses its meta row (and a thread no other message names), so the
 * message leaves every thread count and a later delivery of the same Message-ID is ingested anew. One with a copy in
 * another folder is kept and its mark cleared: a move by another client shows as the source copy gone and the target
 * copy ingested onto the same item. One with a move in flight keeps its mark for a later pass. Repeating it is a
 * no-op. Runs under the mail-thread guard of the caller's transaction.
 */
async function removeEmailsWithoutFolderCopy(
  dbClient: PoolClient,
  emailItemIds: ReadonlySet<string>,
  params: Pick<
    ReconcileImapFolderParams,
    "emailsDatabaseId" | "mailboxItemId" | "moveBaseline" | "protectedMoveMessageIds"
  >,
  relationDefinitionId: string,
): Promise<void> {
  const candidates = new Set([
    ...emailItemIds,
    ...(await listMailMessagesWithFolderCopyRemoved(dbClient, params.mailboxItemId)),
  ]);
  if (candidates.size === 0) return;
  const protectedMoveMessageIds = await protectedMailMovesForPass(
    dbClient,
    params.mailboxItemId,
    params.moveBaseline,
    params.protectedMoveMessageIds,
  );
  for (const emailItemId of candidates) {
    if (protectedMoveMessageIds.has(emailItemId) || (await hasUnsettledMailMove(dbClient, emailItemId))) continue;
    if ((await listRelationsForItem(dbClient, relationDefinitionId, emailItemId)).length > 0) {
      await clearMailMessageFolderCopyRemoved(dbClient, emailItemId);
      continue;
    }
    await itemDeleteWithClient(dbClient, params.emailsDatabaseId, emailItemId, {
      queueAffinity: createActionQueueAffinity(),
      writer: SYSTEM_WRITER,
    });
    await deleteMailMessageMetaOfRemovedItem(dbClient, emailItemId);
  }
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

function newPassBudget(): ImapPassBudget {
  return { full: IMAP_FULL_MESSAGES_PER_PASS, index: IMAP_INDEX_MESSAGES_PER_PASS };
}

/**
 * One folder on its own, outside an account pass, with one pass's budget: the live step, then the backfill step, each
 * fetched with no transaction open and written in its own transactions, and a final one removing the messages whose
 * last copy vanished. A folder another pass moved on in between is left as that pass wrote it (incomplete).
 */
export async function reconcileImapFolder(
  pool: Pool,
  imap: ImapMailClient,
  params: ReconcileImapFolderParams,
): Promise<ReconcileImapFolderResult> {
  const { snapshot, relationDefinitionId, connectedAt } = await withTransaction(pool, async (client) => {
    await lockMailThreadMutation(client);
    await ensureMailAccountSyncState(client, { itemId: params.mailboxItemId, syncMode: "imap" });
    return {
      connectedAt: await anchorMailAccountConnection(client, params.mailboxItemId),
      snapshot: await ensureMailFolderSyncState(client, params.folderItemId),
      relationDefinitionId: await requireFolderRelationDefinitionId(client, params.folderRelationPropertyId),
    };
  });
  const spool = createAttachmentSpool();
  try {
    const ctx: ImapPassContext = {
      pool,
      imap,
      capabilities: await imap.getCapabilities(),
      params,
      relationDefinitionId,
      connectedAt,
      budget: newPassBudget(),
      spool,
      takenMessageIds: new Set(),
      write: (fn) =>
        withBatchStorage(params.storage, (storage) =>
          withTransaction(pool, async (client) => {
            await lockMailThreadMutation(client);
            return { value: await fn(client, storage) };
          }),
        ),
    };
    const live = await syncImapFolderLive(ctx, params.folderPath, snapshot);
    if (live.kind !== "written") return { ingested: 0, complete: false };
    const backfill = await backfillImapFolder(ctx, params.folderPath, live.state);
    await withTransaction(pool, async (client) => {
      await lockMailThreadMutation(client);
      await removeEmailsWithoutFolderCopy(client, new Set(live.copiesRemovedFrom), params, relationDefinitionId);
    });
    if (backfill.kind !== "written") return { ingested: live.ingested, complete: false };
    return {
      ingested: live.ingested + backfill.ingested,
      complete: live.complete && backfill.state.backfillBelowUid === null,
    };
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
  pass: MailSyncPass;
}

/** The inbox first, so a new account shows its current mail before the backfill of other folders. */
function inboxFirst(folders: ImapFolderRef[]): ImapFolderRef[] {
  const isInbox = (folder: ImapFolderRef) => folder.specialUse === "\\Inbox" || folder.path.toUpperCase() === "INBOX";
  return [...folders.filter(isInbox), ...folders.filter((folder) => !isInbox(folder))];
}

/**
 * One pass over an account. Nothing the provider is asked runs inside a transaction: the folder list (with each
 * folder's STATUS where the client lists it, so an unchanged folder's live step is skipped without a SELECT), each
 * folder's selection and fetches (attachment bytes spooled to temp files) and the flag write-back happen between
 * short transactions, each of which re-enters the pass under the mailbox guard and the tenant's mail-thread guard. A
 * prepare transaction discovers Folder items and reads their sync state; then every folder's live step (inbox first)
 * is one write transaction, and only after all of them every folder's backfill (inbox first) runs, newest first, in
 * write transactions of at most `IMAP_MESSAGES_PER_BATCH` messages; the write-back's confirmations are another; a
 * final one records the activity and calls `pass.finish`. A failure ends the pass with the batches committed before
 * it kept; recording it is the caller's job.
 */
export async function reconcileImapAccount(
  pool: Pool,
  imap: ImapMailClient,
  params: ReconcileImapAccountParams,
): Promise<MailSyncPassResult> {
  const ended = { ran: false, complete: false };
  const capabilities = await imap.getCapabilities();
  const allFolders = await imap.listFolders();
  const folders = inboxFirst(
    params.folderPaths ? allFolders.filter((f) => params.folderPaths!.includes(f.path)) : allFolders,
  );

  const prepared = await inPassTransaction(pool, params.pass, async (client) => {
    await ensureMailAccountSyncState(client, { itemId: params.mailboxItemId, syncMode: "imap" });
    const connectedAt = await anchorMailAccountConnection(client, params.mailboxItemId);
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
        ...imapProviderFolder(folder),
      });
      tracked.push({ folder, folderItemId, snapshot: await ensureMailFolderSyncState(client, folderItemId) });
    }
    return {
      connectedAt,
      folders: tracked,
      folderRelationDefinitionId: folderRelationDefinition.id,
      mailboxFolderRelationDefinitionId: mailboxFolderRelationDefinition.id,
    };
  });
  if (!prepared) return ended;
  const { connectedAt, folderRelationDefinitionId, mailboxFolderRelationDefinitionId } = prepared.value;

  const budget = newPassBudget();
  const takenMessageIds = new Set<string>();
  let complete = true;
  // A folder whose backfill a native client holds leaves the history unfinished without asking for a rerun.
  let backfillLeased = false;
  // Decided in the final transaction, once every folder's new copies are in: a moved message keeps its item.
  const copiesRemovedFrom = new Set<string>();
  const spool = createAttachmentSpool();
  try {
    const contextOf = (folder: ImapFolderRef, folderItemId: string): ImapPassContext => ({
      pool,
      imap,
      capabilities,
      params: {
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
      },
      relationDefinitionId: folderRelationDefinitionId,
      connectedAt,
      budget,
      spool,
      takenMessageIds,
      write: (fn) =>
        withBatchStorage(params.storage, (storage) =>
          inPassTransaction(pool, params.pass, (client) => fn(client, storage)),
        ),
    });
    const states = new Map(prepared.value.folders.map(({ folderItemId, snapshot }) => [folderItemId, snapshot]));
    let overtaken = false;
    for (const { folder, folderItemId, snapshot } of prepared.value.folders) {
      // Nothing to select, fetch or write for the live step; the backfill below still runs.
      if (folder.status && unchangedSinceLastReconcile(snapshot, folder.status)) continue;
      const step = await syncImapFolderLive(contextOf(folder, folderItemId), folder.path, snapshot);
      if (step.kind === "ended") return ended;
      // Another pass moved this folder on since its state was read: this pass stops and leaves the rest to a later one.
      if (step.kind === "overtaken") {
        overtaken = true;
        break;
      }
      states.set(folderItemId, step.state);
      if (!step.complete) complete = false;
      for (const emailItemId of step.copiesRemovedFrom) copiesRemovedFrom.add(emailItemId);
    }
    if (overtaken) complete = false;
    else {
      for (const { folder, folderItemId } of prepared.value.folders) {
        const snapshot = states.get(folderItemId);
        if (!snapshot || snapshot.backfillBelowUid === null) continue;
        const step = await backfillImapFolder(contextOf(folder, folderItemId), folder.path, snapshot);
        if (step.kind === "ended") return ended;
        if (step.kind === "overtaken") {
          complete = false;
          break;
        }
        if (step.kind === "leased") {
          backfillLeased = true;
          continue;
        }
        if (!step.complete) complete = false;
      }
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
    await removeEmailsWithoutFolderCopy(client, copiesRemovedFrom, params, folderRelationDefinitionId);
    // Periodic reconcile is the only mechanism here; IDLE just triggers it earlier. An unfinished backfill is due at
    // once, so the sweep resumes it even if the follow-up job is lost; one a native client holds is not.
    await recordImapActivity(client, {
      itemId: params.mailboxItemId,
      nextExpectedActivityAt: complete ? new Date(Date.now() + 30 * 60 * 1000) : new Date(),
      completesInitialSync: complete && !backfillLeased,
    });
    await params.pass.finish(client, { complete });
  });
  if (!finished) return ended;
  return { ran: true, complete };
}
