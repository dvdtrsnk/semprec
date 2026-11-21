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
  getMailMessageMetaByMailboxAndMessageId,
  getMailMessageMetaByProviderMessageId,
  listKnownProviderMessageIds,
} from "./mailMessageMetaStore.js";
import {
  anchorMailAccountConnection,
  ensureMailAccountSyncState,
  invalidateGmailHistory,
  lockGmailSyncCursor,
  recordGmailActivity,
  recordGmailSyncCursor,
  sameGmailSyncCursor,
  type GmailListingPhase,
  type GmailSyncCursor,
} from "./mailAccountSyncStateStore.js";
import { mailArrivalOf, type MailArrival } from "./mailArrival.js";
import { MAIL_FULL_CONTENT_WINDOW_DAYS } from "./mailContentState.js";
import { createAttachmentSpool, type AttachmentSpool } from "./mailAttachmentSpool.js";
import { inPassTransaction, withBatchStorage, type MailSyncPass, type MailSyncPassResult } from "./mailSyncPass.js";
import type { BlobStorageWriter } from "./blobStorage.js";
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

export interface GmailHistoryResult {
  /** true = the stored `historyId` is older than what the API retains (`history.list` 404) — caller must run a full resync. */
  invalidated: boolean;
  newHistoryId: string;
  /** Deduplicated by message id; only the latest state matters. */
  changedMessageIds: string[];
  removedMessageIds: string[];
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
/** Messages the listing ingests in full in one pass: each costs its body and its attachments' bytes. */
export const GMAIL_FULL_MESSAGES_PER_PASS = 50;
/** Index messages, and messages the mailbox already holds, the listing ingests in one pass. */
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

/**
 * Fetches `ids` with no transaction open: a message the mailbox already holds by its Gmail id only as metadata (its
 * labels and flags are what can change), an index-phase message as metadata with its snippet, any other one in full
 * with its attachments spooled. A message deleted since it was listed is left out.
 */
async function prepareGmailBatch(
  ctx: GmailPassContext,
  ids: readonly string[],
  source: "history" | GmailListingPhase,
): Promise<PreparedGmailMessage[]> {
  const known = await withTransaction(ctx.pool, (client) =>
    listKnownProviderMessageIds(client, ctx.params.mailboxItemId, ids),
  );
  const prepared: PreparedGmailMessage[] = [];
  for (const id of ids) {
    const isKnown = known.has(id);
    const format: GmailMessageFormat = isKnown || source === "index" ? "metadata" : "full";
    const fetched = await ctx.gmail.fetchMessage(id, format);
    if (!fetched) continue;
    const arrival = mailArrivalOf({
      reportedNew: source === "history",
      date: fetched.message.date,
      connectedAt: ctx.connectedAt,
    });
    let content: IngestedMailContent | null = null;
    if (!isKnown && format === "full") {
      const { bodyText, bodyHtml, attachments } = fetched.message;
      content = { contentState: "full", bodyText, bodyHtml, attachments: await ctx.spool.spool(attachments) };
    } else if (!isKnown) {
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

/** Drops every folder edge of the messages `history.list` reports deleted. */
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

/**
 * The live step: the messages `history.list` reports since the stored history id, new mail in full, in write
 * transactions of at most `GMAIL_MESSAGES_PER_BATCH` messages; the last one also drops the edges of deleted messages
 * and stores the new history id. It is bounded by the history alone, not by the pass budget: an interrupted step
 * lists the same history again, and the messages its committed batches wrote are then known and fetched as metadata.
 * A history id too old for `history.list` (404) restarts the full listing from a history id captured before it.
 */
async function syncGmailHistory(
  ctx: GmailPassContext,
  cursor: GmailSyncCursor & { historyId: string },
): Promise<GmailStep> {
  const history = await ctx.gmail.listHistorySince(cursor.historyId);
  if (history.invalidated) {
    // Captured before the listing: what arrives meanwhile is reported by the history after it.
    const historyId = await ctx.gmail.getCurrentHistoryId();
    return writeGmailStep(ctx, cursor, async (client) => {
      await invalidateGmailHistory(
        client,
        ctx.params.mailboxItemId,
        "history.list: historyId too old, running full resync",
      );
      return { cursor: { historyId, listingPhase: "full", listingPageToken: null }, stopped: false };
    });
  }
  const changed = history.changedMessageIds;
  if (changed.length === 0 && history.removedMessageIds.length === 0 && history.newHistoryId === cursor.historyId)
    return { kind: "written", cursor, stopped: false };
  let current: GmailSyncCursor = cursor;
  for (let offset = 0; ; offset += GMAIL_MESSAGES_PER_BATCH) {
    const last = offset + GMAIL_MESSAGES_PER_BATCH >= changed.length;
    const batch = await prepareGmailBatch(ctx, changed.slice(offset, offset + GMAIL_MESSAGES_PER_BATCH), "history");
    const expected = current;
    const step = await writeGmailStep(ctx, expected, async (client, protectedMoveMessageIds, storage) => {
      const ingested = await ingestGmailBatch(client, ctx, protectedMoveMessageIds, storage, batch);
      if (ingested < batch.length) return { cursor: expected, stopped: true };
      if (!last) return { cursor: expected, stopped: false };
      await removeGmailMessages(client, ctx, protectedMoveMessageIds, history.removedMessageIds);
      return { cursor: { ...expected, historyId: history.newHistoryId }, stopped: false };
    });
    if (step.kind !== "written" || step.stopped || last) return step;
    current = step.cursor;
  }
}

/** One listing page of the current phase, newest first, in one write transaction that moves the listing on. */
async function listGmailPage(
  ctx: GmailPassContext,
  cursor: GmailSyncCursor & { listingPhase: GmailListingPhase },
  budget: { full: number; index: number },
): Promise<GmailStep> {
  const phase = cursor.listingPhase;
  const page = await ctx.gmail.listMessageIds(gmailListingQuery(phase, ctx.connectedAt), cursor.listingPageToken);
  const batch = await prepareGmailBatch(ctx, page.ids, phase);
  for (const item of batch) budget[item.content?.contentState === "full" ? "full" : "index"]--;
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
    let step: GmailStep;
    const { historyId } = cursor;
    if (historyId !== null) {
      step = await syncGmailHistory(ctx, { ...cursor, historyId });
    } else {
      // A first pass: the history id is captured before the listing begins, so the live step of later passes applies
      // everything that arrives meanwhile.
      const capturedHistoryId = await gmail.getCurrentHistoryId();
      step = await writeGmailStep(ctx, cursor, async () => ({
        cursor: { historyId: capturedHistoryId, listingPhase: "full", listingPageToken: null },
        stopped: false,
      }));
    }
    const budget = { full: GMAIL_FULL_MESSAGES_PER_PASS, index: GMAIL_INDEX_MESSAGES_PER_PASS };
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
