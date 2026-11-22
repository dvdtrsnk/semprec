import type { GraphMoveResult } from "./mailMoveProviderAdapters.js";
import { hasUnsettledMailMove, protectedMailMovesForPass, type MailMoveBaseline } from "./mailMessageMoveSyncStore.js";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem, otherSide } from "../chokePoint/relationsStore.js";
import { ValidationError } from "../errors.js";
import { ensureFolderItem, type ProviderFolder } from "./folderDiscovery.js";
import { ingestEmailMessage, type IngestedMailContent } from "./ingest.js";
import { createGraphMailFlagWritebackAdapter, writeBackProviderFlags } from "./mailFlagWriteback.js";
import { recordConfirmedMailMessageFlag } from "./mailMessageFlagSyncStore.js";
import {
  getMailMessageMetaByMailboxAndMessageId,
  getMailMessageMetaByProviderMessageId,
  listKnownMailMessageIds,
} from "./mailMessageMetaStore.js";
import {
  anchorMailAccountConnection,
  ensureMailAccountSyncState,
  lockGraphSyncCursor,
  recordGraphActivity,
  recordGraphSyncCursor,
  sameGraphSyncCursor,
  type GraphSyncCursor,
} from "./mailAccountSyncStateStore.js";
import { mailArrivalOf, type MailArrival } from "./mailArrival.js";
import { mailContentStateOf } from "./mailContentState.js";
import { createAttachmentSpool, type AttachmentSpool } from "./mailAttachmentSpool.js";
import { inPassTransaction, withBatchStorage, type MailSyncPass, type MailSyncPassResult } from "./mailSyncPass.js";
import type { ClassifiedAttachment } from "./attachments.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import { logger } from "./logger.js";
import type { FetchedMessage } from "./providerTypes.js";

/** Messages one pass ingests in full: each costs a body request, an attachment list and the attachments' bytes. */
export const GRAPH_FULL_MESSAGES_PER_PASS = 50;
/** Index messages, and messages the mailbox already holds, one pass ingests. */
export const GRAPH_INDEX_MESSAGES_PER_PASS = 500;

/** A message as a delta page lists it: envelope, threading and delivery headers and flags, no body. */
export type GraphMessageEnvelope = Omit<FetchedMessage, "bodyText" | "bodyHtml" | "attachments">;

/** The body and attachments of a full message, fetched on their own. */
export interface GraphMessageContent {
  bodyText?: string;
  bodyHtml?: string;
  attachments: ClassifiedAttachment[];
}

export interface GraphFolderRef {
  id: string;
  displayName: string;
  wellKnownName?: string;
}

export interface GraphChangedMessage {
  id: string;
  /** Absent when `removed` is true. */
  parentFolderId?: string;
  removed: boolean;
  message?: GraphMessageEnvelope;
  /** `bodyPreview`, the snippet an index message keeps. */
  preview?: string;
}

/** One page of a delta round: exactly one of `nextLink` (more pages) and `deltaLink` (the round's end) is set. */
export interface GraphDeltaPage {
  changes: GraphChangedMessage[];
  nextLink: string | null;
  deltaLink: string | null;
}

export interface GraphMailClient {
  observeMoveMessage?(messageId: string): Promise<GraphMoveResult>;
  moveMessage?(
    messageId: string,
    destination: "archive" | "deleteditems" | "inbox" | "sentitems",
  ): Promise<GraphMoveResult>;
  listFolders(): Promise<GraphFolderRef[]>;
  /**
   * One page of a mailbox-wide delta round: `url` is a stored next or delta link, `null` starts a round from scratch.
   * `null` = `410 Gone`/`resyncRequired`; the caller must run a full resync.
   */
  fetchDeltaPage(url: string | null): Promise<GraphDeltaPage | null>;
  /** The body and attachments of a full message; `null` = the message is gone. */
  fetchMessageContent(messageId: string): Promise<GraphMessageContent | null>;
  patchMessage(
    messageId: string,
    patch: { isRead: boolean } | { flag: { flagStatus: "flagged" | "notFlagged" } },
  ): Promise<void>;
}

function specialPurposeForGraphFolder(folder: GraphFolderRef): string {
  const known: Record<string, string> = {
    inbox: "inbox",
    sentitems: "sent",
    junkemail: "junk",
    deleteditems: "trash",
    drafts: "drafts",
    archive: "archive",
  };
  return (folder.wellKnownName && known[folder.wellKnownName.toLowerCase()]) ?? "none";
}

/** A Graph mail folder as its Folder item. */
export function graphProviderFolder(folder: GraphFolderRef): ProviderFolder {
  return {
    providerId: folder.id,
    name: folder.displayName,
    behavior: "folder",
    specialPurpose: specialPurposeForGraphFolder(folder),
  };
}

export interface ReconcileGraphAccountParams {
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

/** A delta change ready to be written: a removal, or a message with its arrival decided and its content fetched. */
type PreparedGraphChange =
  | { kind: "removed"; id: string }
  | {
      kind: "message";
      id: string;
      folderItemId: string;
      message: GraphMessageEnvelope;
      arrival: MailArrival;
      /** `null`: the mailbox held its Message-ID when the page was prepared, so none of its content was fetched. */
      content: IngestedMailContent | null;
    };

/** What every fetch and write of one pass shares. */
interface GraphPassContext {
  pool: Pool;
  graph: GraphMailClient;
  params: ReconcileGraphAccountParams;
  relationDefinitionId: string;
  connectedAt: Date;
  folderItemIdByGraphId: ReadonlyMap<string, string>;
  spool: AttachmentSpool;
}

/** How a step ended: the pass ended, another pass moved the cursor on, or the cursor it left. */
type GraphStep =
  | { kind: "ended" }
  | { kind: "overtaken" }
  | {
      kind: "written";
      cursor: GraphSyncCursor;
      /** A message prepared as known was gone at the write, so the step stopped before it; a later pass resumes. */
      stopped: boolean;
    };

/**
 * Decides each change of a page and fetches what it needs, with no transaction open: a message whose Message-ID the
 * mailbox already holds nothing, a `full` one (`mailContentStateOf`) its body and attachment list (attachments
 * spooled), an `index` one nothing (its preview is the delta's `bodyPreview`; no attachment metadata is recorded,
 * which keeps the backfill to one request per page). Spends the pass budget. A message in a folder the pass does not
 * know, or gone before its body was fetched, is left out.
 */
async function prepareGraphPage(
  ctx: GraphPassContext,
  changes: readonly GraphChangedMessage[],
  reportedNew: boolean,
  budget: { full: number; index: number },
): Promise<PreparedGraphChange[]> {
  const messageIds = changes.flatMap((change) => (change.message ? [change.message.messageId] : []));
  const known = await withTransaction(ctx.pool, (client) =>
    listKnownMailMessageIds(client, ctx.params.mailboxItemId, messageIds),
  );
  const prepared: PreparedGraphChange[] = [];
  for (const change of changes) {
    if (change.removed) {
      prepared.push({ kind: "removed", id: change.id });
      continue;
    }
    const folderItemId = change.parentFolderId ? ctx.folderItemIdByGraphId.get(change.parentFolderId) : undefined;
    const { message } = change;
    if (!folderItemId || !message) continue;
    const arrival = mailArrivalOf({ reportedNew, date: message.date, connectedAt: ctx.connectedAt });
    let content: IngestedMailContent | null = null;
    if (known.has(message.messageId)) {
      budget.index--;
    } else if (mailContentStateOf({ arrival, date: message.date, connectedAt: ctx.connectedAt }) === "full") {
      const fetched = await ctx.graph.fetchMessageContent(change.id);
      if (!fetched) continue;
      budget.full--;
      content = { contentState: "full", ...fetched, attachments: await ctx.spool.spool(fetched.attachments) };
    } else {
      budget.index--;
      content = {
        contentState: "index",
        ...(change.preview !== undefined ? { snippet: change.preview } : {}),
        attachments: [],
      };
    }
    prepared.push({ kind: "message", id: change.id, folderItemId, message, arrival, content });
  }
  return prepared;
}

async function removeGraphMessageEdges(
  client: PoolClient,
  ctx: GraphPassContext,
  itemId: string,
  keepFolderItemId: string | null,
): Promise<void> {
  const edges = await listRelationsForItem(client, ctx.relationDefinitionId, itemId);
  for (const edge of edges) {
    const folderItemId = otherSide(edge, itemId);
    if (folderItemId === keepFolderItemId) continue;
    await deleteRelationWithClient(
      client,
      { relationPropertyId: ctx.params.folderRelationPropertyId, callerItemId: itemId, targetItemId: folderItemId },
      EMAILS_RELATION_CONTEXT,
    );
  }
}

/**
 * Writes `page` in order and returns how many changes it wrote. Graph messages live in exactly one folder; one
 * reappearing under a different `parentFolderId` is a move, so its stale folder edge is dropped. A message prepared
 * as known whose Message-ID the mailbox no longer holds (removed since) ends the page there, unwritten.
 */
async function writeGraphPage(
  client: PoolClient,
  ctx: GraphPassContext,
  protectedMoveMessageIds: ReadonlySet<string>,
  storage: BlobStorageWriter,
  page: readonly PreparedGraphChange[],
): Promise<number> {
  const { params } = ctx;
  for (const [position, change] of page.entries()) {
    if (change.kind === "removed") {
      const meta = await getMailMessageMetaByProviderMessageId(client, change.id);
      if (!meta || protectedMoveMessageIds.has(meta.itemId) || (await hasUnsettledMailMove(client, meta.itemId)))
        continue;
      await removeGraphMessageEdges(client, ctx, meta.itemId, null);
      continue;
    }
    if (
      change.content === null &&
      !(await getMailMessageMetaByMailboxAndMessageId(client, params.mailboxItemId, change.message.messageId))
    )
      return position;
    const result = await ingestEmailMessage(client, {
      arrival: change.arrival,
      emailsDatabaseId: params.emailsDatabaseId,
      filesDatabaseId: params.filesDatabaseId,
      folderRelationPropertyId: params.folderRelationPropertyId,
      attachmentsRelationPropertyId: params.attachmentsRelationPropertyId,
      folderItemId: change.folderItemId,
      mailboxItemId: params.mailboxItemId,
      protectedMoveMessageIds,
      providerMessageId: change.id,
      storage,
      storageKeyPrefix: params.storageKeyPrefix,
      mailboxAliases: params.mailboxAliases,
      ...change.message,
      // A known message converges onto the stored one, which keeps its own content.
      ...(change.content ?? { contentState: "index", attachments: [] }),
    });
    if (protectedMoveMessageIds.has(result.itemId) || (await hasUnsettledMailMove(client, result.itemId))) continue;
    await removeGraphMessageEdges(client, ctx, result.itemId, change.folderItemId);
  }
  return page.length;
}

/**
 * One write transaction of a pass under the mail-thread guard. The account's sync state row is locked and its cursor
 * must still be `expected`; otherwise another pass has moved it on, nothing is written and the step is overtaken, so a
 * cursor never moves backwards. `fn` returns the cursor the write leaves. A failed write deletes the attachment bytes
 * it stored.
 */
async function writeGraphStep(
  ctx: GraphPassContext,
  expected: GraphSyncCursor,
  fn: (
    client: PoolClient,
    protectedMoveMessageIds: ReadonlySet<string>,
    storage: BlobStorageWriter,
  ) => Promise<{
    cursor: GraphSyncCursor;
    stopped: boolean;
  }>,
): Promise<GraphStep> {
  const { params } = ctx;
  const written = await withBatchStorage(params.storage, (storage) =>
    inPassTransaction(ctx.pool, params.pass, async (client) => {
      const current = await lockGraphSyncCursor(client, params.mailboxItemId);
      if (!current || !sameGraphSyncCursor(current, expected)) return null;
      const protectedMoveMessageIds = await protectedMailMovesForPass(
        client,
        params.mailboxItemId,
        params.moveBaseline,
        params.protectedMoveMessageIds,
      );
      const outcome = await fn(client, protectedMoveMessageIds, storage);
      if (!sameGraphSyncCursor(outcome.cursor, current))
        await recordGraphSyncCursor(client, params.mailboxItemId, outcome.cursor);
      return outcome;
    }),
  );
  if (!written) return { kind: "ended" };
  if (!written.value) return { kind: "overtaken" };
  return { kind: "written", ...written.value };
}

/**
 * One pass over a Graph account. Nothing the provider is asked runs inside a transaction: the folder list, each delta
 * page (no body; `GRAPH_DELTA_PAGE_SIZE` messages with the REST client), each full message's body and attachment list
 * (attachment bytes spooled to temp files) and the flag write-back happen between short transactions, each of which
 * re-enters the pass under the mailbox guard and takes the tenant's mail-thread guard. A prepare transaction writes
 * the Folder items; then the delta round continues where the stored cursor left it, one page per write transaction
 * that stores the page's next link (`graph_delta_next_link`), until the page carrying the round's delta link, which
 * replaces `graph_delta_link`, or until the pass budget is spent. Messages of a round started from the stored delta
 * link are reported as new; a round from scratch (first pass, or after a 410) is backfill, `full` inside the content
 * window and `index` beyond it. A pass that leaves its round unfinished is incomplete; the caller schedules the next
 * one. A failure ends the pass with the pages committed before it kept; recording it is the caller's job.
 */
export async function reconcileGraphAccount(
  pool: Pool,
  graph: GraphMailClient,
  params: ReconcileGraphAccountParams,
): Promise<MailSyncPassResult> {
  const ended = { ran: false, complete: false };
  const folders = await graph.listFolders();

  const prepared = await inPassTransaction(pool, params.pass, async (client) => {
    const [folderRelationDefinition, mailboxFolderRelationDefinition] = await Promise.all([
      getRelationDefinitionByPropertyId(client, params.folderRelationPropertyId),
      getRelationDefinitionByPropertyId(client, params.mailboxFolderRelationPropertyId),
    ]);
    if (!folderRelationDefinition || !mailboxFolderRelationDefinition)
      throw new ValidationError("Mail folder relation definitions are missing from the email module schema");
    const state = await ensureMailAccountSyncState(client, { itemId: params.mailboxItemId, syncMode: "graph_api" });
    const connectedAt = await anchorMailAccountConnection(client, params.mailboxItemId);
    const folderItemIdByGraphId = new Map<string, string>();
    for (const folder of folders) {
      const folderItemId = await ensureFolderItem(client, {
        foldersDatabaseId: params.foldersDatabaseId,
        mailboxItemId: params.mailboxItemId,
        mailboxRelationPropertyId: params.mailboxFolderRelationPropertyId,
        ...graphProviderFolder(folder),
      });
      folderItemIdByGraphId.set(folder.id, folderItemId);
    }
    const cursor: GraphSyncCursor = { deltaLink: state.graphDeltaLink, nextLink: state.graphDeltaNextLink };
    return {
      connectedAt,
      cursor,
      folderItemIdByGraphId,
      folderRelationDefinitionId: folderRelationDefinition.id,
      mailboxFolderRelationDefinitionId: mailboxFolderRelationDefinition.id,
    };
  });
  if (!prepared) return ended;
  const { folderRelationDefinitionId, mailboxFolderRelationDefinitionId } = prepared.value;

  const spool = createAttachmentSpool();
  let cursor = prepared.value.cursor;
  let complete = false;
  try {
    const ctx: GraphPassContext = {
      pool,
      graph,
      params,
      relationDefinitionId: folderRelationDefinitionId,
      connectedAt: prepared.value.connectedAt,
      folderItemIdByGraphId: prepared.value.folderItemIdByGraphId,
      spool,
    };
    const budget = { full: GRAPH_FULL_MESSAGES_PER_PASS, index: GRAPH_INDEX_MESSAGES_PER_PASS };
    for (;;) {
      const url = cursor.nextLink ?? cursor.deltaLink;
      const page = await graph.fetchDeltaPage(url);
      let step: GraphStep;
      if (!page) {
        if (url === null) throw new Error("Microsoft Graph refused a delta round from scratch as expired");
        // A resync is no failure, so it leaves `last_error` to the pass's outcome.
        logger.info({ mailboxItemId: params.mailboxItemId }, "Graph delta link expired; a round from scratch starts");
        step = await writeGraphStep(ctx, cursor, async () => ({
          cursor: { deltaLink: null, nextLink: null },
          stopped: false,
        }));
      } else {
        const expected = cursor;
        const changes = await prepareGraphPage(ctx, page.changes, expected.deltaLink !== null, budget);
        step = await writeGraphStep(ctx, expected, async (client, protectedMoveMessageIds, storage) => {
          const written = await writeGraphPage(client, ctx, protectedMoveMessageIds, storage, changes);
          if (written < changes.length) return { cursor: expected, stopped: true };
          return {
            cursor: page.deltaLink
              ? { deltaLink: page.deltaLink, nextLink: null }
              : { deltaLink: expected.deltaLink, nextLink: page.nextLink },
            stopped: false,
          };
        });
      }
      if (step.kind === "ended") return ended;
      // Another pass moved the cursor on since it was read: this pass stops and leaves the rest to a later one.
      if (step.kind === "overtaken" || step.stopped) break;
      cursor = step.cursor;
      if (page?.deltaLink) {
        complete = true;
        break;
      }
      if (page && (budget.full <= 0 || budget.index <= 0)) break;
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
    createGraphMailFlagWritebackAdapter(graph),
  );
  if (!applied) return ended;

  const finished = await inPassTransaction(pool, params.pass, async (client) => {
    for (const write of applied) {
      await recordConfirmedMailMessageFlag(client, write.messageItemId, write.propertyKey, write.desiredState);
    }
    // An unfinished round is due at once, so the sweep resumes it even if the follow-up job is lost.
    await recordGraphActivity(client, {
      itemId: params.mailboxItemId,
      nextExpectedActivityAt: complete ? new Date(Date.now() + 15 * 60 * 1000) : new Date(),
      completesInitialSync: complete,
    });
    await params.pass.finish(client, { complete });
  });
  if (!finished) return ended;
  return { ran: true, complete };
}
