import type { GmailMoveResult } from "./mailMoveProviderAdapters.js";
import { hasUnsettledMailMove, protectedMailMovesForPass, type MailMoveBaseline } from "./mailMessageMoveSyncStore.js";
import type { Pool, PoolClient } from "pg";
import { currentTenantScope, TenantScopeMissingError } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { ValidationError } from "../errors.js";
import { ensureFolderItem, type ProviderFolder } from "./folderDiscovery.js";
import { ingestEmailMessage, type IngestedMailContent } from "./ingest.js";
import { createGmailMailFlagWritebackAdapter, writeBackProviderFlags } from "./mailFlagWriteback.js";
import { recordConfirmedMailMessageFlag } from "./mailMessageFlagSyncStore.js";
import {
  deleteMailMessageMetaOfRemovedItem,
  getMailMessageMetaByMailboxAndMessageId,
  getMailMessageMetaByProviderMessageId,
  listKnownProviderMessageIds,
} from "./mailMessageMetaStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import {
  anchorMailAccountConnection,
  ensureMailAccountSyncState,
  lockGmailSyncCursor,
  recordGmailActivity,
  recordGmailSyncCursor,
  sameGmailSyncCursor,
  type GmailListingPhase,
  type GmailSyncCursor,
} from "./mailAccountSyncStateStore.js";
import { mailArrivalOf, type MailArrival } from "./mailArrival.js";
import { MAIL_FULL_CONTENT_WINDOW_DAYS, mailContentStateOf } from "./mailContentState.js";
import { createAttachmentSpool, type AttachmentSpool } from "./mailAttachmentSpool.js";
import { inPassTransaction, withBatchStorage, type MailSyncPass, type MailSyncPassResult } from "./mailSyncPass.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import { logger } from "./logger.js";
import type { FetchedMessage } from "./providerTypes.js";

export interface GmailLabelRef {
  id: string;
  name: string;
  /** Gmail `type` field: 'system' labels (INBOX/SENT/...) map to a stable `specialPurpose`; 'user' labels don't. */
  type: "system" | "user";
}

export interface GmailFetchedMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  /** Gmail's short plain-text extract of the body. */
  snippet?: string;
  /** Of a `metadata` fetch: no body parts and no attachments. */
  message: FetchedMessage;
}

/** `full`: headers, body parts and attachment parts; `metadata`: the headers ingest reads, labels and snippet. */
export type GmailMessageFormat = "full" | "metadata";

export interface GmailMessageIdPage {
  /** Newest first, as `messages.list` orders them. */
  ids: string[];
  nextPageToken: string | null;
}

/** One `history.list` record: the messages it added or relabelled, and the ones it deleted, each id once. */
export interface GmailHistoryRecord {
  /** The record's history id; a pass that applied every record up to it resumes after it. */
  id: string;
  changedMessageIds: string[];
  removedMessageIds: string[];
}

export interface GmailHistoryResult {
  /** true = the stored `historyId` is older than what the API retains (`history.list` 404) — caller must run a full resync. */
  invalidated: boolean;
  /** The mailbox's history id as of the listing, at or after the last record's. */
  newHistoryId: string;
  /** In history order. */
  records: GmailHistoryRecord[];
}

export interface GmailMailClient {
  observeMoveMessage?(messageId: string): Promise<GmailMoveResult>;
  applyMoveStep?(messageId: string, step: "trash" | "untrash" | "add_inbox" | "remove_inbox"): Promise<GmailMoveResult>;
  getCurrentHistoryId(): Promise<string>;
  listHistorySince(startHistoryId: string): Promise<GmailHistoryResult>;
  /** One page of ids matching the Gmail search `query`, at most `GMAIL_LISTING_PAGE_SIZE` with the REST client. */
  listMessageIds(query: string, pageToken: string | null): Promise<GmailMessageIdPage>;
  /** null = the message was deleted after it was listed or reported. */
  fetchMessage(id: string, format: GmailMessageFormat): Promise<GmailFetchedMessage | null>;
  listLabels(): Promise<GmailLabelRef[]>;
  modifyMessageLabels(messageId: string, addLabelIds: string[], removeLabelIds: string[]): Promise<void>;
}

/** The Gmail system labels that are real places mail lives in; every other system label (UNREAD, STARRED, IMPORTANT, CATEGORY_*, CHAT) is a flag or a tab, not a folder. */
const GMAIL_SYSTEM_FOLDER_PURPOSES: Record<string, string> = {
  INBOX: "inbox",
  SENT: "sent",
  SPAM: "junk",
  TRASH: "trash",
  DRAFT: "drafts",
};

/** The system labels a pass writes as folders; Gmail names a system label by its id. */
export const GMAIL_SYSTEM_FOLDERS: readonly ProviderFolder[] = Object.entries(GMAIL_SYSTEM_FOLDER_PURPOSES).map(
  ([id, specialPurpose]) => ({ providerId: id, name: id, behavior: "label", specialPurpose }),
);

/** Provider id of the synthetic Archive folder (Gmail has no archive label: archived mail is mail without INBOX). */
export const GMAIL_ARCHIVE_PROVIDER_ID = "semprec:archive";

/** Provider ids of the five system labels; a message carrying none of them is archived. */
export const GMAIL_PLACEMENT_LABEL_IDS: readonly string[] = Object.keys(GMAIL_SYSTEM_FOLDER_PURPOSES);

/** Serializes participating Gmail folder writers for one tenant and mailbox until transaction end. */
export async function lockGmailFolderState(client: PoolClient, mailboxItemId: string): Promise<void> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new TenantScopeMissingError("Gmail folder state requires a tenant scope");
  const key = `gmail-folder-state:v1:${scope.tenantId.toLowerCase()}:${mailboxItemId.toLowerCase()}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [key]);
}

function specialPurposeForLabel(label: GmailLabelRef): string {
  return GMAIL_SYSTEM_FOLDER_PURPOSES[label.id] ?? "none";
}

function isFolderLabel(label: GmailLabelRef): boolean {
  return label.type === "user" || Object.hasOwn(GMAIL_SYSTEM_FOLDER_PURPOSES, label.id);
}

/** Messages of the history one write transaction ingests; a listing page is written in one transaction. */
export const GMAIL_MESSAGES_PER_BATCH = 50;
/** Messages the live step and the listing ingest in full in one pass: each costs its body and attachments' bytes. */
export const GMAIL_FULL_MESSAGES_PER_PASS = 50;
/** Index messages, and messages the mailbox already holds, the live step and the listing ingest in one pass. */
export const GMAIL_INDEX_MESSAGES_PER_PASS = 500;

const FULL_CONTENT_WINDOW_SECONDS = MAIL_FULL_CONTENT_WINDOW_DAYS * 24 * 60 * 60;

/**
 * The search a listing phase pages through. `after:`/`before:` compare the message's internal date with epoch
 * seconds; the index phase reaches one second past the window start, so the phases leave no gap and a message both
 * list is ingested once (dedup by Message-ID).
 */
function gmailListingQuery(phase: GmailListingPhase, connectedAt: Date): string {
  const windowStart = Math.floor(connectedAt.getTime() / 1000) - FULL_CONTENT_WINDOW_SECONDS;
  return phase === "full" ? `after:${windowStart}` : `before:${windowStart + 1}`;
}

export interface ReconcileGmailAccountParams {
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
  /** This mailbox's registered addresses, used as deliveredToAddress's alias fallback. Defaults to `[]`. */
  mailboxAliases?: string[];
  pass: MailSyncPass;
}

/** A message ready to be written: its arrival decided, its content fetched and its attachments spooled. */
interface PreparedGmailMessage {
  fetched: GmailFetchedMessage;
  arrival: MailArrival;
  /** `null`: the mailbox held the message when the batch was prepared, so only its metadata was fetched. */
  content: IngestedMailContent | null;
}

/** What every fetch and write of one pass shares. */
interface GmailPassContext {
  pool: Pool;
  gmail: GmailMailClient;
  params: ReconcileGmailAccountParams;
  relationDefinitionId: string;
  connectedAt: Date;
  folderItemIdByLabel: ReadonlyMap<string, string>;
  archiveFolderItemId: string;
  spool: AttachmentSpool;
}

/** How a step ended: the pass ended, another pass moved the cursor on, or the cursor it left. */
type GmailStep =
  | { kind: "ended" }
  | { kind: "overtaken" }
  | {
      kind: "written";
      cursor: GmailSyncCursor;
      /** A message prepared as known was gone at the write, so the step stopped before it; a later pass resumes. */
      stopped: boolean;
    };

/** What is left of a pass's budget: full messages, and index or known ones. */
interface GmailPassBudget {
  full: number;
  index: number;
}

/**
 * Fetches `ids` with no transaction open, each charged to `budget` by what it costs: a message the mailbox already
 * holds by its Gmail id only as metadata (its labels and flags are what can change; index), a listed message by its
 * listing phase (`full` in full with its attachments spooled, `index` as metadata with its snippet), and one the
 * history reports first as metadata, then in full only when its arrival and Date make it `full`
 * (`mailContentStateOf`): old mail another client labels or moves is stored as an index. A message deleted since it
 * was listed is left out.
 */
async function prepareGmailBatch(
  ctx: GmailPassContext,
  ids: readonly string[],
  source: "history" | GmailListingPhase,
  budget: GmailPassBudget,
): Promise<PreparedGmailMessage[]> {
  const known = await withTransaction(ctx.pool, (client) =>
    listKnownProviderMessageIds(client, ctx.params.mailboxItemId, ids),
  );
  const prepared: PreparedGmailMessage[] = [];
  for (const id of ids) {
    const isKnown = known.has(id);
    const listedFull = !isKnown && source === "full";
    let fetched = await ctx.gmail.fetchMessage(id, listedFull ? "full" : "metadata");
    if (!fetched) continue;
    const arrival = mailArrivalOf({
      reportedNew: source === "history",
      date: fetched.message.date,
      connectedAt: ctx.connectedAt,
    });
    const state = isKnown
      ? null
      : source === "history"
        ? mailContentStateOf({ arrival, date: fetched.message.date, connectedAt: ctx.connectedAt })
        : source;
    if (state === "full" && !listedFull) {
      fetched = await ctx.gmail.fetchMessage(id, "full");
      if (!fetched) continue;
    }
    budget[state === "full" ? "full" : "index"]--;
    let content: IngestedMailContent | null = null;
    if (state === "full") {
      const { bodyText, bodyHtml, attachments } = fetched.message;
      content = { contentState: "full", bodyText, bodyHtml, attachments: await ctx.spool.spool(attachments) };
    } else if (state === "index") {
      content = {
        contentState: "index",
        ...(fetched.snippet !== undefined ? { snippet: fetched.snippet } : {}),
        attachments: [],
      };
    }
    prepared.push({ fetched, arrival, content });
  }
  return prepared;
}

/**
 * One Gmail message keeps one id across all its labels, so it is ingested once (deduped by Message-ID) and linked to
 * every mapped label's Folder; edges for labels it no longer carries are removed.
 */
async function ingestGmailMessage(
  client: PoolClient,
  ctx: GmailPassContext,
  protectedMoveMessageIds: ReadonlySet<string>,
  storage: BlobStorageWriter,
  item: PreparedGmailMessage,
): Promise<void> {
  const { params } = ctx;
  const { fetched } = item;
  const mappedFolderIds = fetched.labelIds
    .map((labelId) => ctx.folderItemIdByLabel.get(labelId))
    .filter((v): v is string => Boolean(v));
  // No INBOX/SPAM/TRASH/SENT/DRAFT label = archived (also a message with no labels at all).
  if (!fetched.labelIds.some((labelId) => GMAIL_PLACEMENT_LABEL_IDS.includes(labelId)))
    mappedFolderIds.push(ctx.archiveFolderItemId);
  const { bodyText: _bodyText, bodyHtml: _bodyHtml, attachments: _attachments, ...envelope } = fetched.message;
  let itemId: string | null = null;
  for (const folderItemId of mappedFolderIds) {
    const result = await ingestEmailMessage(client, {
      arrival: item.arrival,
      emailsDatabaseId: params.emailsDatabaseId,
      filesDatabaseId: params.filesDatabaseId,
      folderRelationPropertyId: params.folderRelationPropertyId,
      attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
      folderItemId,
      mailboxItemId: params.mailboxItemId,
      protectedMoveMessageIds,
      providerMessageId: fetched.id,
      providerThreadId: fetched.threadId,
      storage,
      storageKeyPrefix: params.storageKeyPrefix,
      mailboxAliases: params.mailboxAliases,
      ...envelope,
      // A known message converges onto the stored one, which keeps its own content.
      ...(item.content ?? { contentState: "index", attachments: [] }),
    });
    itemId = result.itemId;
  }

  // A message mapping to no known Folder is not ingested above, but if already known its stale folder edges still
  // need dropping.
  if (!itemId) {
    const existing = await getMailMessageMetaByProviderMessageId(client, fetched.id);
    itemId = existing?.itemId ?? null;
  }

  if (itemId && !protectedMoveMessageIds.has(itemId) && !(await hasUnsettledMailMove(client, itemId))) {
    const currentEdges = await listRelationsForItem(client, ctx.relationDefinitionId, itemId);
    const mappedSet = new Set(mappedFolderIds);
    for (const edge of currentEdges) {
      const folderItemId = otherSide(edge, itemId);
      if (!mappedSet.has(folderItemId)) {
        await deleteRelationWithClient(
          client,
          { relationPropertyId: params.folderRelationPropertyId, callerItemId: itemId, targetItemId: folderItemId },
          EMAILS_RELATION_CONTEXT,
        );
      }
    }
  }
}

/**
 * Ingests `batch` in order and returns how many it wrote. A message prepared as known whose Message-ID the mailbox no
 * longer holds (removed since) ends the batch there, unwritten, so a later pass fetches its content.
 */
async function ingestGmailBatch(
  client: PoolClient,
  ctx: GmailPassContext,
  protectedMoveMessageIds: ReadonlySet<string>,
  storage: BlobStorageWriter,
  batch: readonly PreparedGmailMessage[],
): Promise<number> {
  for (const [position, item] of batch.entries()) {
    if (
      item.content === null &&
      !(await getMailMessageMetaByMailboxAndMessageId(client, ctx.params.mailboxItemId, item.fetched.message.messageId))
    )
      return position;
    await ingestGmailMessage(client, ctx, protectedMoveMessageIds, storage, item);
  }
  return batch.length;
}

/**
 * Removes each message `history.list` reports deleted: a Gmail message keeps one id across all its labels, so a
 * deleted one is gone from the whole account. Its folder edges are dropped, then the Email is trashed as the system
 * writer and loses its meta row (and a thread no other message names), as an IMAP pass does for a message whose last
 * folder copy vanished. A message with a move in flight is left for a later pass.
 */
async function removeGmailMessages(
  client: PoolClient,
  ctx: GmailPassContext,
  protectedMoveMessageIds: ReadonlySet<string>,
  removedIds: readonly string[],
): Promise<void> {
  for (const id of removedIds) {
    const meta = await getMailMessageMetaByProviderMessageId(client, id);
    if (!meta || protectedMoveMessageIds.has(meta.itemId) || (await hasUnsettledMailMove(client, meta.itemId)))
      continue;
    const currentEdges = await listRelationsForItem(client, ctx.relationDefinitionId, meta.itemId);
    for (const edge of currentEdges) {
      const folderItemId = otherSide(edge, meta.itemId);
      await deleteRelationWithClient(
        client,
        {
          relationPropertyId: ctx.params.folderRelationPropertyId,
          callerItemId: meta.itemId,
          targetItemId: folderItemId,
        },
        EMAILS_RELATION_CONTEXT,
      );
    }
    await itemDeleteWithClient(client, ctx.params.emailsDatabaseId, meta.itemId, {
      queueAffinity: createActionQueueAffinity(),
      writer: SYSTEM_WRITER,
    });
    await deleteMailMessageMetaOfRemovedItem(client, meta.itemId);
  }
}

/**
 * One write transaction of a pass under the mail-thread guard and the Gmail folder-state guard. The account's sync
 * state row is locked and its cursor must still be `expected`; otherwise another pass has moved it on, nothing is
 * written and the step is overtaken, so a cursor never moves backwards. `fn` returns the cursor the write leaves.
 * A failed write deletes the attachment bytes it stored.
 */
async function writeGmailStep(
  ctx: GmailPassContext,
  expected: GmailSyncCursor,
  fn: (
    client: PoolClient,
    protectedMoveMessageIds: ReadonlySet<string>,
    storage: BlobStorageWriter,
  ) => Promise<{
    cursor: GmailSyncCursor;
    stopped: boolean;
  }>,
): Promise<GmailStep> {
  const { params } = ctx;
  const written = await withBatchStorage(params.storage, (storage) =>
    inPassTransaction(ctx.pool, params.pass, async (client) => {
      await lockGmailFolderState(client, params.mailboxItemId);
      const current = await lockGmailSyncCursor(client, params.mailboxItemId);
      if (!current || !sameGmailSyncCursor(current, expected)) return null;
      const protectedMoveMessageIds = await protectedMailMovesForPass(
        client,
        params.mailboxItemId,
        params.moveBaseline,
        params.protectedMoveMessageIds,
      );
      const outcome = await fn(client, protectedMoveMessageIds, storage);
      if (!sameGmailSyncCursor(outcome.cursor, current))
        await recordGmailSyncCursor(client, params.mailboxItemId, outcome.cursor);
      return outcome;
    }),
  );
  if (!written) return { kind: "ended" };
  if (!written.value) return { kind: "overtaken" };
  return { kind: "written", ...written.value };
}

/** A run of the history written in one transaction: its changed messages, deleted ones and the cursor after it. */
interface GmailHistoryChunk {
  changed: string[];
  removed: string[];
  /** The id of the last record the chunk completes; `null` when it completes none. */
  throughRecordId: string | null;
  /** The chunk ends where a record ends, so the next one starts a record. */
  endsAtRecordEnd: boolean;
}

/**
 * Splits the history, in its order, into chunks of at most `GMAIL_MESSAGES_PER_BATCH` changed messages (a message
 * reported by several records once, at its first: its fetch gives its state after all of them); a record larger than a
 * chunk spans several. A record's deleted messages go with the chunk that completes it. The last chunk, possibly
 * empty, completes the history.
 */
function historyChunks(records: readonly GmailHistoryRecord[]): GmailHistoryChunk[] {
  const chunks: GmailHistoryChunk[] = [];
  const seen = new Set<string>();
  let chunk: GmailHistoryChunk = { changed: [], removed: [], throughRecordId: null, endsAtRecordEnd: true };
  // Whether the record being split has put a message into `chunk` yet.
  let recordInChunk = false;
  for (const record of records) {
    for (const id of record.changedMessageIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (chunk.changed.length === GMAIL_MESSAGES_PER_BATCH) {
        chunks.push({ ...chunk, endsAtRecordEnd: !recordInChunk });
        chunk = { changed: [], removed: [], throughRecordId: null, endsAtRecordEnd: true };
      }
      chunk.changed.push(id);
      recordInChunk = true;
    }
    chunk.removed.push(...record.removedMessageIds);
    chunk.throughRecordId = record.id;
    recordInChunk = false;
  }
  chunks.push(chunk);
  return chunks;
}

/**
 * The live step: the messages `history.list` reports since the stored history id, in history order, written in
 * transactions of at most `GMAIL_MESSAGES_PER_BATCH` messages, each storing the id of the last record it completed (the
 * last one the new history id) and dropping the edges of the messages the records it covers deleted. Each message is
 * charged to the pass budget (`prepareGmailBatch`); once the budget is spent the step stops at the next record's
 * start, so a record is never split between passes and the stored id never passes an unapplied record. The next pass
 * lists the history from there. A history id too old for `history.list` (404) restarts the full listing from a history
 * id captured before it.
 */
async function syncGmailHistory(
  ctx: GmailPassContext,
  cursor: GmailSyncCursor & { historyId: string },
  budget: GmailPassBudget,
): Promise<GmailStep> {
  const history = await ctx.gmail.listHistorySince(cursor.historyId);
  if (history.invalidated) {
    // Captured before the listing: what arrives meanwhile is reported by the history after it.
    const historyId = await ctx.gmail.getCurrentHistoryId();
    // A resync is no failure, so it leaves `last_error` to the pass's outcome.
    logger.info({ mailboxItemId: ctx.params.mailboxItemId }, "Gmail history expired; the mailbox is listed again");
    return writeGmailStep(ctx, cursor, async () => ({
      cursor: { historyId, listingPhase: "full", listingPageToken: null },
      stopped: false,
    }));
  }
  if (history.records.length === 0 && history.newHistoryId === cursor.historyId)
    return { kind: "written", cursor, stopped: false };
  const chunks = historyChunks(history.records);
  let current: GmailSyncCursor = cursor;
  for (const [index, chunk] of chunks.entries()) {
    const last = index === chunks.length - 1;
    const batch = await prepareGmailBatch(ctx, chunk.changed, "history", budget);
    const expected = current;
    const step = await writeGmailStep(ctx, expected, async (client, protectedMoveMessageIds, storage) => {
      const ingested = await ingestGmailBatch(client, ctx, protectedMoveMessageIds, storage, batch);
      if (ingested < batch.length) return { cursor: expected, stopped: true };
      await removeGmailMessages(client, ctx, protectedMoveMessageIds, chunk.removed);
      const historyId = last ? history.newHistoryId : (chunk.throughRecordId ?? expected.historyId);
      return { cursor: { ...expected, historyId }, stopped: false };
    });
    if (step.kind !== "written" || step.stopped || last) return step;
    current = step.cursor;
    // The next chunk starts a record: the budget decides whether this pass takes it.
    if (chunk.endsAtRecordEnd && (budget.full <= 0 || budget.index <= 0)) return { ...step, stopped: true };
  }
  return { kind: "written", cursor: current, stopped: false };
}

/** One listing page of the current phase, newest first, in one write transaction that moves the listing on. */
async function listGmailPage(
  ctx: GmailPassContext,
  cursor: GmailSyncCursor & { listingPhase: GmailListingPhase },
  budget: GmailPassBudget,
): Promise<GmailStep> {
  const phase = cursor.listingPhase;
  const page = await ctx.gmail.listMessageIds(gmailListingQuery(phase, ctx.connectedAt), cursor.listingPageToken);
  const batch = await prepareGmailBatch(ctx, page.ids, phase, budget);
  return writeGmailStep(ctx, cursor, async (client, protectedMoveMessageIds, storage) => {
    const ingested = await ingestGmailBatch(client, ctx, protectedMoveMessageIds, storage, batch);
    if (ingested < batch.length) return { cursor, stopped: true };
    const next: GmailSyncCursor =
      page.nextPageToken !== null
        ? { ...cursor, listingPageToken: page.nextPageToken }
        : { ...cursor, listingPhase: phase === "full" ? "index" : null, listingPageToken: null };
    return { cursor: next, stopped: false };
  });
}

/**
 * One pass over a Gmail account. Nothing the provider is asked runs inside a transaction: the label list, the
 * history, each listing page, each message (in full or as metadata, attachment bytes spooled to temp files) and the
 * flag write-back happen between short transactions, each of which re-enters the pass under the mailbox guard and
 * takes the tenant's mail-thread guard and the Gmail folder-state guard. A prepare transaction writes the label
 * Folders; then the live step applies the history since the stored history id (reported as new); then the full
 * listing of a first pass or of a resync after history invalidation continues where the stored listing cursor left
 * it: first the messages whose internal date lies inside the full-content window (`full`), then the older ones as
 * `index` (snippet, no body, no attachment metadata: `format=metadata` lists no parts), each newest first, one page
 * per write transaction, while the pass budget lasts. The listing is backfill; its history id was captured before the
 * listing began and stored with its cursor, so mail arriving meanwhile reaches the next passes' live step. A pass that leaves the listing or the history unfinished is incomplete; the caller schedules the
 * next one. A failure ends the pass with the batches committed before it kept; recording it is the caller's job.
 */
export async function reconcileGmailAccount(
  pool: Pool,
  gmail: GmailMailClient,
  params: ReconcileGmailAccountParams,
): Promise<MailSyncPassResult> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new TenantScopeMissingError("Gmail reconciliation requires a tenant scope");
  const ended = { ran: false, complete: false };
  const labels = await gmail.listLabels();

  const prepared = await inPassTransaction(pool, params.pass, async (client) => {
    await lockGmailFolderState(client, params.mailboxItemId);
    const [folderRelationDefinition, mailboxFolderRelationDefinition] = await Promise.all([
      getRelationDefinitionByPropertyId(client, params.folderRelationPropertyId),
      getRelationDefinitionByPropertyId(client, params.mailboxFolderRelationPropertyId),
    ]);
    if (!folderRelationDefinition || !mailboxFolderRelationDefinition)
      throw new ValidationError("Mail folder relation definitions are missing from the email module schema");
    const state = await ensureMailAccountSyncState(client, { itemId: params.mailboxItemId, syncMode: "gmail_api" });
    const connectedAt = await anchorMailAccountConnection(client, params.mailboxItemId);
    const folderItemIdByLabel = new Map<string, string>();
    for (const label of labels) {
      if (!isFolderLabel(label)) continue;
      const folderItemId = await ensureFolderItem(client, {
        foldersDatabaseId: params.foldersDatabaseId,
        mailboxItemId: params.mailboxItemId,
        mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
        providerId: label.id,
        name: label.name,
        behavior: "label",
        specialPurpose: specialPurposeForLabel(label),
      });
      folderItemIdByLabel.set(label.id, folderItemId);
    }
    const archiveFolderItemId = await ensureFolderItem(client, {
      foldersDatabaseId: params.foldersDatabaseId,
      mailboxItemId: params.mailboxItemId,
      mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
      providerId: GMAIL_ARCHIVE_PROVIDER_ID,
      name: "Archive",
      behavior: "label",
      specialPurpose: "archive",
    });
    const cursor: GmailSyncCursor = {
      historyId: state.gmailHistoryId,
      listingPhase: state.gmailListingPhase,
      listingPageToken: state.gmailListingPageToken,
    };
    return {
      connectedAt,
      cursor,
      folderItemIdByLabel,
      archiveFolderItemId,
      folderRelationDefinitionId: folderRelationDefinition.id,
      mailboxFolderRelationDefinitionId: mailboxFolderRelationDefinition.id,
    };
  });
  if (!prepared) return ended;
  const { folderRelationDefinitionId, mailboxFolderRelationDefinitionId } = prepared.value;

  const spool = createAttachmentSpool();
  let cursor = prepared.value.cursor;
  let complete = true;
  try {
    const ctx: GmailPassContext = {
      pool,
      gmail,
      params,
      relationDefinitionId: folderRelationDefinitionId,
      connectedAt: prepared.value.connectedAt,
      folderItemIdByLabel: prepared.value.folderItemIdByLabel,
      archiveFolderItemId: prepared.value.archiveFolderItemId,
      spool,
    };
    // Shared by the live step and the listing, so history the pass applies leaves less of the listing to it.
    const budget: GmailPassBudget = { full: GMAIL_FULL_MESSAGES_PER_PASS, index: GMAIL_INDEX_MESSAGES_PER_PASS };
    let step: GmailStep;
    const { historyId } = cursor;
    if (historyId !== null) {
      step = await syncGmailHistory(ctx, { ...cursor, historyId }, budget);
    } else {
      // A first pass: the history id is captured before the listing begins, so the live step of later passes applies
      // everything that arrives meanwhile.
      const capturedHistoryId = await gmail.getCurrentHistoryId();
      step = await writeGmailStep(ctx, cursor, async () => ({
        cursor: { historyId: capturedHistoryId, listingPhase: "full", listingPageToken: null },
        stopped: false,
      }));
    }
    for (;;) {
      if (step.kind === "ended") return ended;
      // Another pass moved the cursor on since it was read: this pass stops and leaves the rest to a later one.
      if (step.kind === "overtaken" || step.stopped) {
        complete = false;
        break;
      }
      cursor = step.cursor;
      const { listingPhase } = cursor;
      if (listingPhase === null) break;
      if (budget.index <= 0 || (listingPhase === "full" && budget.full <= 0)) {
        complete = false;
        break;
      }
      step = await listGmailPage(ctx, { ...cursor, listingPhase }, budget);
    }
  } finally {
    await spool.remove();
  }

  const applied = await writeBackProviderFlags(
    pool,
    params.pass,
    {
      mailboxItemId: params.mailboxItemId,
      moveBaseline: params.moveBaseline,
      protectedMoveMessageIds: params.protectedMoveMessageIds,
      folderRelationDefinitionId,
      mailboxFolderRelationDefinitionId,
    },
    createGmailMailFlagWritebackAdapter(gmail),
  );
  if (!applied) return ended;

  const finished = await inPassTransaction(pool, params.pass, async (client) => {
    for (const write of applied) {
      await recordConfirmedMailMessageFlag(client, write.messageItemId, write.propertyKey, write.desiredState);
    }
    // The watch renewal job renews the watch daily; this only advances liveness bookkeeping. An unfinished listing is
    // due at once, so the sweep resumes it even if the follow-up job is lost.
    await recordGmailActivity(client, {
      itemId: params.mailboxItemId,
      nextExpectedActivityAt: complete ? new Date(Date.now() + 15 * 60 * 1000) : new Date(),
      completesInitialSync: complete,
    });
    await params.pass.finish(client, { complete });
  });
  if (!finished) return ended;
  return { ran: true, complete };
}
