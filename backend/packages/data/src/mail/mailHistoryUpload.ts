import { randomUUID } from "node:crypto";
import type { MessageStructureObject } from "imapflow";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import type { CustomRouteResult, RouteBody, RouteParams, RouteUser } from "../customRoute.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError, NotFoundError, RateLimitedError, ValidationError } from "../errors.js";
import { parseAddressListProperty } from "./addressListParsing.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import { IMAP_LIGHT_FETCH_HEADERS, lightFetchedMessageOf } from "./imapLightFetch.js";
import {
  MalformedImapFetchResponseError,
  parseImapFetchResponse,
  type ImapFetchResponse,
} from "./imapFetchResponseParser.js";
import { IMAP_MESSAGES_PER_BATCH, type ImapFetchedMessage } from "./imapReconcile.js";
import { bodyPartPrefixInText, IMAP_SNIPPET_BYTES, imapSnippetText } from "./imapSnippet.js";
import { ingestEmailMessage } from "./ingest.js";
import { getMailAccountSyncState, recordImapInitialSyncCompleted } from "./mailAccountSyncStateStore.js";
import {
  claimClientBackfillLeases,
  listMailboxFolderSyncStates,
  lockMailFolderSyncState,
  recordClientBackfill,
  releaseClientBackfillLeases,
  type MailboxFolderSyncState,
} from "./mailFolderSyncStateStore.js";
import { protectedMailMovesForPass } from "./mailMessageMoveSyncStore.js";
import { resolveMailModuleIds, type MailModuleIds } from "./mailModuleIds.js";
import { lockMailboxSync, MAILBOX_REMOVAL_SYNC_WAIT_MS } from "./mailboxSyncGuard.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";

/**
 * The data items a native client asks its IMAP server for, `UID FETCH <uids> MAIL_HISTORY_FETCH_ITEMS`, and whose
 * untagged FETCH responses it uploads: what the sync's light fetch reads, plus the first `IMAP_SNIPPET_BYTES` octets of
 * the TEXT section for the snippet.
 */
export const MAIL_HISTORY_FETCH_ITEMS =
  `(UID FLAGS ENVELOPE BODYSTRUCTURE BODY.PEEK[HEADER.FIELDS (${IMAP_LIGHT_FETCH_HEADERS.map((name) => name.toUpperCase()).join(" ")})] ` +
  `BODY.PEEK[TEXT]<0.${IMAP_SNIPPET_BYTES}>)`;

/** How long a claim or an accepted slice leases a folder's backfill to the client. */
export const MAIL_HISTORY_LEASE_MS = 10 * 60 * 1000;
/** UIDs, and messages, one upload may carry. */
export const MAIL_HISTORY_MAX_MESSAGES = 500;
/** The largest raw FETCH response of one message, decoded. */
export const MAIL_HISTORY_MAX_FETCH_BYTES = 64 * 1024;
/** The largest upload request body; the route reads no more. */
export const MAIL_HISTORY_MAX_BODY_BYTES = 8 * 1024 * 1024;

const MAX_IMAP_UID = 4_294_967_295;

/** Why a mailbox's history cannot be uploaded now. */
export const MAIL_HISTORY_UNAVAILABLE_REASONS = [
  // Gmail and Microsoft accounts import their history server-side.
  "notImap",
  // Mail is switched off, or the account was never connected.
  "mailboxUnavailable",
  // The server refused the stored sign-in; only signing in again helps.
  "reauthorizationRequired",
] as const;
export type MailHistoryUnavailableReason = (typeof MAIL_HISTORY_UNAVAILABLE_REASONS)[number];

/** 409 `mail_history_unavailable` with `details.reason`. */
export class MailHistoryUnavailableError extends ConflictError {
  constructor(readonly reason: MailHistoryUnavailableReason) {
    super("The mailbox's history cannot be uploaded", { reason }, "mail_history_unavailable");
    this.name = "MailHistoryUnavailableError";
  }
}

type ThrottleAttempt = { granted: true } | { granted: false; retryAfterSeconds: number };

export interface MailHistoryThrottle {
  /** Checks and counts in the same synchronous step, per user. */
  tryAcquire(action: "mailHistoryUpload", userId: string): ThrottleAttempt;
}

export interface MailHistoryRouteDependencies {
  throttle?: MailHistoryThrottle;
}

/** Counts one claim or upload of the user; a refusal is 429 `rate_limited`. A mount without a throttle fails (500). */
function acquireMailHistoryRequest(dependencies: MailHistoryRouteDependencies, userId: string): void {
  const { throttle } = dependencies;
  if (throttle === undefined) throw new Error('custom route dependency "throttle" is not configured');
  const attempt = throttle.tryAcquire("mailHistoryUpload", userId);
  if (!attempt.granted) throw new RateLimitedError(attempt.retryAfterSeconds);
}

/** A malformed, unknown, foreign or trashed mailbox id: the same answer. */
function mailboxNotFound(): NotFoundError {
  return new NotFoundError("Mailbox not found");
}

const mailboxIdSchema = z.uuid();

function requireMailboxId(params: Record<string, string>): string {
  const parsed = mailboxIdSchema.safeParse(params.id);
  if (!parsed.success) throw mailboxNotFound();
  return parsed.data;
}

/** A refused body names the first offending field by its path (`messages.3.fetch`) and repeats none of its values. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown, message: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path ?? [];
    throw new ValidationError(message, path.length > 0 ? { field: path.map(String).join(".") } : undefined);
  }
  return parsed.data;
}

/**
 * Enters the mailbox's history in a write transaction: the mailbox sync guard first (a removal or the Mail switch
 * then waits for this transaction, as for a sync pass's), then the live Mailboxes item and its sync state. Only an IMAP
 * account with Mail on whose sign-in the server has not refused takes an upload.
 */
async function enterMailboxHistory(
  client: PoolClient,
  mailboxItemId: string,
): Promise<{ ids: MailModuleIds; mailboxAliases: string[] }> {
  await lockMailboxSync(client, mailboxItemId, { maxWaitMs: MAILBOX_REMOVAL_SYNC_WAIT_MS });
  const ids = await resolveMailModuleIds(client);
  const mailbox = await getItemById(client, ids.mailboxesDatabaseId, mailboxItemId);
  if (mailbox === null || mailbox.deletedAt) throw mailboxNotFound();
  const state = await getMailAccountSyncState(client, mailboxItemId);
  if (state === null || state.syncPausedAt !== null) throw new MailHistoryUnavailableError("mailboxUnavailable");
  if (state.syncMode !== "imap") throw new MailHistoryUnavailableError("notImap");
  if (state.lastFailureKind === "reauthorization") throw new MailHistoryUnavailableError("reauthorizationRequired");
  return { ids, mailboxAliases: parseAddressListProperty(mailbox.properties.addresses) };
}

/** A folder some backfill of the server still has to reach before the rest of its history is index-only. */
function inFullBackfill(folder: MailboxFolderSyncState): boolean {
  return folder.liveFromUid === null || (folder.backfillBelowUid !== null && !folder.backfillIndexOnly);
}

export interface MailHistoryClaim {
  leaseToken: string;
  /** When the leases granted end unless renewed; `null` when none was granted. */
  leaseExpiresAt: string | null;
  folders: Array<{ folderId: string; path: string; uidvalidity: number; backfillBelowUid: number }>;
  /** Some folder is still in the server's in-window backfill (or not synced yet): claiming again later may lease it. */
  pendingFullBackfill: boolean;
}

const claimBodySchema = z.strictObject({ leaseToken: z.uuid().optional() });

/**
 * `POST /api/mail/mailboxes/:id/history-index/claim`: leases, under the given token or a new one, every folder of the
 * mailbox whose backfill is index-only and unfinished and that no other client holds. A lease the token already holds
 * is renewed.
 */
export function createMailHistoryClaimRouteHandler(pool: Pool, dependencies: MailHistoryRouteDependencies) {
  return async (ctx: RouteParams & RouteBody & RouteUser): Promise<CustomRouteResult<MailHistoryClaim>> => {
    const mailboxItemId = requireMailboxId(ctx.params);
    acquireMailHistoryRequest(dependencies, ctx.identity.user.id);
    const body = parseBody(claimBodySchema, ctx.body, "The body may hold only 'leaseToken', a UUID");
    const leaseToken = body.leaseToken ?? randomUUID();
    const claim = await withTransaction(pool, async (client) => {
      const { ids } = await enterMailboxHistory(client, mailboxItemId);
      const folders = await listMailboxFolderSyncStates(client, {
        foldersDatabaseId: ids.foldersDatabaseId,
        mailboxItemId,
      });
      const leases = await claimClientBackfillLeases(
        client,
        folders.map((folder) => folder.itemId),
        leaseToken,
        MAIL_HISTORY_LEASE_MS,
      );
      const leaseOf = new Map(leases.map((lease) => [lease.itemId, lease]));
      return {
        leaseToken,
        leaseExpiresAt: leases[0]?.leaseUntil.toISOString() ?? null,
        folders: folders.flatMap((folder) => {
          const lease = leaseOf.get(folder.itemId);
          return lease
            ? [
                {
                  folderId: folder.itemId,
                  path: folder.path,
                  uidvalidity: Number(lease.uidvalidity),
                  backfillBelowUid: Number(lease.backfillBelowUid),
                },
              ]
            : [];
        }),
        pendingFullBackfill: folders.length === 0 || folders.some(inFullBackfill),
      };
    });
    return { status: 200, body: claim };
  };
}

const releaseBodySchema = z.strictObject({ leaseToken: z.uuid() });

/** `POST /api/mail/mailboxes/:id/history-index/release`: ends every lease the token holds on the mailbox's folders. */
export function createMailHistoryReleaseRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteBody): Promise<CustomRouteResult<{ released: number }>> => {
    const mailboxItemId = requireMailboxId(ctx.params);
    const { leaseToken } = parseBody(releaseBodySchema, ctx.body, "The body must hold 'leaseToken', a UUID");
    const released = await withTransaction(pool, async (client) => {
      const { ids } = await enterMailboxHistory(client, mailboxItemId);
      const folders = await listMailboxFolderSyncStates(client, {
        foldersDatabaseId: ids.foldersDatabaseId,
        mailboxItemId,
      });
      return releaseClientBackfillLeases(
        client,
        folders.map((folder) => folder.itemId),
        leaseToken,
      );
    });
    return { status: 200, body: { released } };
  };
}

const uidSchema = z.number().int().min(1).max(MAX_IMAP_UID);
// Base64 without line breaks, padded; `Buffer.from(s, "base64")` would silently skip anything else.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const uploadBodySchema = z.strictObject({
  leaseToken: z.uuid(),
  folderId: z.uuid(),
  uidvalidity: uidSchema,
  rangeHigh: z.number().int().min(2).max(MAX_IMAP_UID),
  rangeLow: uidSchema,
  uids: z.array(uidSchema).max(MAIL_HISTORY_MAX_MESSAGES),
  messages: z
    .array(
      z.strictObject({
        uid: uidSchema,
        fetch: z
          .string()
          .max(Math.ceil(MAIL_HISTORY_MAX_FETCH_BYTES / 3) * 4)
          .regex(BASE64),
      }),
    )
    .max(MAIL_HISTORY_MAX_MESSAGES),
});

type UploadBody = z.infer<typeof uploadBodySchema>;

/** One uploaded message as the light fetch reads it, with its snippet and its UID. */
interface UploadedMessage {
  uid: number;
  light: Omit<ImapFetchedMessage, "fetchContent">;
  snippet?: string;
}

/**
 * The snippet the sync would store: the first `IMAP_SNIPPET_BYTES` octets of the snippet part BODYSTRUCTURE names, here
 * found in the leading octets of the TEXT section (the section itself for a single-part message). A multipart message
 * whose part content starts beyond the cut has none.
 */
function uploadedSnippet(
  light: Omit<ImapFetchedMessage, "fetchContent">,
  text: Buffer,
  root: MessageStructureObject,
): string | undefined {
  const part = light.snippetPart;
  if (part === undefined) return undefined;
  const bytes = part.section === "TEXT" ? text : bodyPartPrefixInText(text, root, part.section);
  return bytes === undefined ? undefined : imapSnippetText(bytes, part);
}

/** Parses one message's raw FETCH response; a refusal names `messages.<index>.fetch`. */
async function parseUploadedMessage(index: number, uid: number, encoded: string): Promise<UploadedMessage> {
  const field = `messages.${index}.fetch`;
  const raw = Buffer.from(encoded, "base64");
  if (raw.length > MAIL_HISTORY_MAX_FETCH_BYTES)
    throw new ValidationError(`A FETCH response may hold at most ${MAIL_HISTORY_MAX_FETCH_BYTES} octets`, { field });
  let response: ImapFetchResponse;
  try {
    response = await parseImapFetchResponse(raw);
  } catch (error) {
    if (error instanceof MalformedImapFetchResponseError)
      throw new ValidationError(`Not one untagged FETCH response: ${error.reason}`, { field });
    throw error;
  }
  const { message, hasHeaderFields, sections } = response;
  if (message.uid !== uid) throw new ValidationError("The FETCH response is of another UID", { field });
  const text = sections.get("text");
  if (
    message.flags === undefined ||
    message.envelope === undefined ||
    message.bodyStructure === undefined ||
    !hasHeaderFields ||
    text === undefined
  )
    throw new ValidationError(`The FETCH response lacks an item of ${MAIL_HISTORY_FETCH_ITEMS}`, { field });
  const light = lightFetchedMessageOf(message);
  const snippet = uploadedSnippet(light, text, message.bodyStructure);
  return { uid, light, ...(snippet !== undefined ? { snippet } : {}) };
}

/** The slice's rules a body can break on its own, before any state is read. */
async function parseUploadedSlice(body: UploadBody): Promise<UploadedMessage[]> {
  if (body.rangeLow >= body.rangeHigh)
    throw new ValidationError("'rangeLow' must lie below 'rangeHigh'", { field: "rangeLow" });
  const uids = new Set(body.uids);
  if (uids.size !== body.uids.length) throw new ValidationError("'uids' lists a UID twice", { field: "uids" });
  if (body.uids.some((uid) => uid < body.rangeLow || uid >= body.rangeHigh))
    throw new ValidationError("'uids' must lie in [rangeLow, rangeHigh)", { field: "uids" });
  const messageUids = new Set(body.messages.map((message) => message.uid));
  if (messageUids.size !== body.messages.length)
    throw new ValidationError("'messages' holds a UID twice", { field: "messages" });
  if (messageUids.size !== uids.size || body.uids.some((uid) => !messageUids.has(uid)))
    throw new ValidationError("'messages' must hold exactly one message for each of 'uids'", { field: "messages" });
  const parsed: UploadedMessage[] = [];
  for (const [index, message] of body.messages.entries())
    parsed.push(await parseUploadedMessage(index, message.uid, message.fetch));
  // Newest first, as the server's backfill writes.
  return parsed.sort((a, b) => b.uid - a.uid);
}

/** Index messages store no attachment byte, so nothing is ever written here. */
const NO_ATTACHMENT_BYTES: BlobStorageWriter = {
  writeStream: () => Promise.reject(new Error("An uploaded index message stores no attachment bytes")),
  delete: async () => {},
  readStream: () => {
    throw new Error("An uploaded index message stores no attachment bytes");
  },
};

export interface MailHistoryUploadResult {
  accepted: number;
  /** The folder's backfill cursor after the slice; `null`: its backfill is done. */
  backfillBelowUid: number | null;
  leaseExpiresAt: string;
}

/**
 * One write transaction of a slice: under the mailbox sync guard and the mail-thread guard, the folder's sync state row
 * is locked and must still be the one the slice continues (the uploaded UIDVALIDITY, an unexpired lease of the token,
 * the cursor at `expectedBelowUid`); then `batch` is ingested as `backfill`/`index` and the cursor moves to `nextBelowUid`
 * with the lease renewed. The last folder backfill of the account to finish completes its initial sync.
 */
async function writeUploadedBatch(
  client: PoolClient,
  input: {
    mailboxItemId: string;
    body: UploadBody;
    batch: readonly UploadedMessage[];
    expectedBelowUid: number;
    nextBelowUid: number | null;
  },
): Promise<{ backfillBelowUid: number | null; leaseExpiresAt: string }> {
  const { mailboxItemId, body } = input;
  const { ids, mailboxAliases } = await enterMailboxHistory(client, mailboxItemId);
  await lockMailThreadMutation(client);
  const folders = await listMailboxFolderSyncStates(client, {
    foldersDatabaseId: ids.foldersDatabaseId,
    mailboxItemId,
  });
  if (!folders.some((folder) => folder.itemId === body.folderId))
    throw new NotFoundError("Folder not found", { field: "folderId" });
  const state = await lockMailFolderSyncState(client, body.folderId);
  if (state === null) throw new NotFoundError("Folder not found", { field: "folderId" });
  if (state.uidvalidity !== String(body.uidvalidity))
    throw new ConflictError("The folder's UIDVALIDITY changed", undefined, "mail_history_uidvalidity_changed");
  if (state.clientBackfillLease?.token !== body.leaseToken)
    throw new ConflictError("The lease on the folder's history ended", undefined, "mail_history_lease_expired");
  if (state.backfillBelowUid !== String(input.expectedBelowUid))
    throw new ConflictError(
      "The folder's history continues elsewhere",
      { backfillBelowUid: state.backfillBelowUid === null ? null : Number(state.backfillBelowUid) },
      "mail_history_range_stale",
    );

  const [folderProperty, attachmentsProperty] = await Promise.all([
    getPropertyByKey(client, ids.emailsDatabaseId, "folder"),
    getPropertyByKey(client, ids.emailsDatabaseId, "attachments"),
  ]);
  if (!folderProperty || !attachmentsProperty) throw new Error("The Emails folder or attachments property is missing");
  const protectedMoveMessageIds = await protectedMailMovesForPass(client, mailboxItemId);
  for (const { uid, light, snippet } of input.batch) {
    await ingestEmailMessage(client, {
      // Below the folder's backfill cursor, so below `live_from_uid`: history, whatever its Date.
      arrival: "backfill",
      emailsDatabaseId: ids.emailsDatabaseId,
      filesDatabaseId: ids.filesDatabaseId,
      folderRelationPropertyId: folderProperty.id,
      attachmentsRelationPropertyId: attachmentsProperty.id,
      folderItemId: body.folderId,
      mailboxItemId,
      protectedMoveMessageIds,
      folderUid: uid,
      storage: NO_ATTACHMENT_BYTES,
      storageKeyPrefix: mailboxItemId,
      mailboxAliases,
      ...light.message,
      // An upload stores an index, also of a message inside the full-content window; its body is read on demand.
      contentState: "index",
      ...(snippet !== undefined ? { snippet } : {}),
      attachments: light.attachments,
    });
  }
  const written = await recordClientBackfill(client, {
    itemId: body.folderId,
    backfillBelowUid: input.nextBelowUid === null ? null : String(input.nextBelowUid),
    token: body.leaseToken,
    leaseMs: MAIL_HISTORY_LEASE_MS,
  });
  const backfillDone = (folder: MailboxFolderSyncState) =>
    folder.itemId === body.folderId
      ? written.backfillBelowUid === null
      : folder.liveFromUid !== null && folder.backfillBelowUid === null;
  if (written.backfillBelowUid === null && folders.every(backfillDone))
    await recordImapInitialSyncCompleted(client, mailboxItemId);
  return {
    backfillBelowUid: written.backfillBelowUid === null ? null : Number(written.backfillBelowUid),
    leaseExpiresAt: written.leaseUntil.toISOString(),
  };
}

/**
 * `POST /api/mail/mailboxes/:id/history-index`: one contiguous slice of a leased folder's history, newest first. The
 * client sent `UID SEARCH UID rangeLow:rangeHigh-1`, then `UID FETCH <uids> MAIL_HISTORY_FETCH_ITEMS`; `rangeHigh` is
 * the folder's backfill cursor, `uids` every UID the search found and `messages` one raw untagged FETCH response per
 * UID. Every response is parsed before anything is written; the slice is then written in transactions of at most
 * `IMAP_MESSAGES_PER_BATCH` messages, newest first, each moving the cursor down to the lowest UID it wrote and the last
 * to `rangeLow` (done at 1). A refusal after a committed batch leaves that prefix written; the claim answers the cursor.
 */
export function createMailHistoryUploadRouteHandler(pool: Pool, dependencies: MailHistoryRouteDependencies) {
  return async (ctx: RouteParams & RouteBody & RouteUser): Promise<CustomRouteResult<MailHistoryUploadResult>> => {
    const mailboxItemId = requireMailboxId(ctx.params);
    acquireMailHistoryRequest(dependencies, ctx.identity.user.id);
    const body = parseBody(
      uploadBodySchema,
      ctx.body,
      "The body must hold 'leaseToken', 'folderId', 'uidvalidity', 'rangeHigh', 'rangeLow', 'uids' and 'messages'",
    );
    const messages = await parseUploadedSlice(body);
    // Every batch but the last ends at the lowest UID it writes, below which the range's UIDs are all still to come;
    // the last ends at `rangeLow`.
    const lastStart =
      messages.length === 0 ? 0 : Math.floor((messages.length - 1) / IMAP_MESSAGES_PER_BATCH) * IMAP_MESSAGES_PER_BATCH;
    let expectedBelowUid = body.rangeHigh;
    for (let start = 0; start < lastStart; start += IMAP_MESSAGES_PER_BATCH) {
      const batch = messages.slice(start, start + IMAP_MESSAGES_PER_BATCH);
      const nextBelowUid = Math.min(...batch.map((message) => message.uid));
      await withTransaction(pool, (client) =>
        writeUploadedBatch(client, { mailboxItemId, body, batch, expectedBelowUid, nextBelowUid }),
      );
      expectedBelowUid = nextBelowUid;
    }
    const written = await withTransaction(pool, (client) =>
      writeUploadedBatch(client, {
        mailboxItemId,
        body,
        batch: messages.slice(lastStart),
        expectedBelowUid,
        nextBelowUid: body.rangeLow === 1 ? null : body.rangeLow,
      }),
    );
    return { status: 200, body: { accepted: messages.length, ...written } };
  };
}
