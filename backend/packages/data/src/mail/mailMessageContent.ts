import type { Readable } from "node:stream";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { z } from "zod";
import { currentTenantScope } from "@semprec/shared";
import { getItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import { getDecryptedCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError, NotFoundError, RateLimitedError, ValidationError } from "../errors.js";
import type { CustomRouteResult, RouteParams, RouteUrl, RouteUser } from "../customRoute.js";
import { requestUrl, requireUuidParam } from "../customRoute.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import { sanitizeMailHtml } from "./htmlSanitize.js";
import { imapConnectionLimitForProvider } from "./imapConnectionLimiter.js";
import type { GmailMailClient } from "./gmailReconcile.js";
import type { GraphMailClient } from "./graphReconcile.js";
import type { ImapMailClient, ImapMessageBody } from "./imapMailClient.js";
import { getMailAccountSyncState, type SyncMode } from "./mailAccountSyncStateStore.js";
import { readFreshMailContentCache, writeMailContentCache, type MailContentCacheRow } from "./mailContentCacheStore.js";
import { readMailMessageAttachments, type MailMessageAttachment } from "./mailMessageAttachments.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { htmlToPlainText } from "./mailPlainText.js";
import type { MailSearchTerms } from "./mailSearchTerms.js";
import { AttachmentCapExceededError, MailReauthorizationRequiredError } from "./providerTypes.js";
import { logger } from "./logger.js";

/** Why a message's content or an attachment's bytes could not be fetched from the provider. */
export const MAIL_CONTENT_UNAVAILABLE_REASONS = [
  // The provider refused the stored sign-in, or none is stored; only the user signing in again helps.
  "reauthorizationRequired",
  // The provider could not be reached, did not answer in time, or failed the request.
  "providerUnreachable",
  // The provider no longer holds the message (or the attachment) where Semprec knows it.
  "messageNotFound",
  // The account is removed or has Mail switched off.
  "mailboxUnavailable",
  // The attachment is larger than `MAX_ATTACHMENT_BYTES`.
  "attachmentTooLarge",
] as const;
export type MailContentUnavailableReason = (typeof MAIL_CONTENT_UNAVAILABLE_REASONS)[number];

/** 409 `mail_content_unavailable` with `details.reason`; names no provider detail. */
export class MailContentUnavailableError extends ConflictError {
  constructor(readonly reason: MailContentUnavailableReason) {
    super("The content cannot be fetched from the mail provider", { reason }, "mail_content_unavailable");
    this.name = "MailContentUnavailableError";
  }
}

/** The sync's full message read, an attachment's bytes by its payload part id and name, and Gmail's own search. */
export interface MailContentGmailClient extends Pick<GmailMailClient, "fetchMessage"> {
  openAttachmentContent(messageId: string, partId: string, filename: string): Promise<Readable | null>;
  searchMessageIds(query: string, limit: number, signal?: AbortSignal): Promise<string[]>;
}

/** The sync's full message read, a file attachment's bytes by its attachment id, and Graph's `$search`. */
export interface MailContentGraphClient extends Pick<GraphMailClient, "fetchMessageContent"> {
  openAttachmentContent(messageId: string, attachmentId: string): Promise<Readable | null>;
  searchMessageIds(terms: MailSearchTerms, limit: number, signal?: AbortSignal): Promise<string[]>;
}

/**
 * The provider clients the on-demand content reads and the provider search use, built by the composition root from
 * the same factories as the sync's: an IMAP client is the account's kept sync session or a new connection under the
 * shared connection limiter.
 */
export interface MailContentProviders {
  createImapClient?: (mailboxItemId: string, credential: string, accountLimit: number) => Promise<ImapMailClient>;
  createGmailClient?: (mailboxItemId: string) => MailContentGmailClient;
  createGraphClient?: (mailboxItemId: string) => MailContentGraphClient;
  /** Where a saved attachment's bytes are written: the mail attachment root. */
  attachmentStorage?: BlobStorageWriter;
}

type ThrottleAttempt = { granted: true } | { granted: false; retryAfterSeconds: number };

export interface MailContentThrottle {
  /** Checks and counts in the same synchronous step, per user. */
  tryAcquire(action: "mailContentFetch", userId: string): ThrottleAttempt;
}

export interface MailContentRouteDependencies {
  mailContent?: MailContentProviders;
  throttle?: MailContentThrottle;
}

/** A missing member is deployment misconfiguration: a plain error (generic 500), not a domain error. */
export function requireMailContentDependency<K extends keyof MailContentRouteDependencies>(
  dependencies: MailContentRouteDependencies,
  member: K,
): NonNullable<MailContentRouteDependencies[K]> {
  const value = dependencies[member];
  if (value === undefined)
    throw new Error(`custom route dependency "${member}" is not configured by the composition root`);
  return value;
}

/** Counts one provider fetch of the user; a refusal is 429 `rate_limited`. */
export function acquireMailContentFetch(dependencies: MailContentRouteDependencies, userId: string): void {
  const attempt = requireMailContentDependency(dependencies, "throttle").tryAcquire("mailContentFetch", userId);
  if (!attempt.granted) throw new RateLimitedError(attempt.retryAfterSeconds);
}

/** One folder edge of an IMAP message: the folder's path, the edge's UID and the folder's stored UIDVALIDITY. */
export interface ImapFolderEdge {
  path: string;
  uid: number | null;
  uidValidity: string | null;
}

/** Where the provider holds a message, read from its meta row, mailbox, sync state and folder edges. */
export interface MailMessageLocator {
  emailId: string;
  mailboxItemId: string;
  syncMode: SyncMode;
  mailboxProvider: string | undefined;
  connectionLimit: unknown;
  messageId: string;
  providerMessageId: string | null;
  /** IMAP only; the edges with a UID first. */
  imapEdges: ImapFolderEdge[];
}

const folderEdgeRow = z.object({
  path: z.string().min(1).max(1024),
  uid: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .nullable(),
  uid_validity: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .nullable(),
});

const MAX_IMAP_UID = 4_294_967_295;

async function readImapFolderEdges(client: PoolClient, emailsDatabaseId: string, emailId: string) {
  const folderProperty = await getPropertyByKey(client, emailsDatabaseId, "folder");
  const definition = folderProperty ? await getRelationDefinitionByPropertyId(client, folderProperty.id) : null;
  if (!definition) throw new Error("The Emails folder property has no relation definition");
  const { rows } = await client.query<{ path: unknown; uid: unknown; uid_validity: unknown }>(
    `SELECT folder.properties->>'providerId' AS path, edge.metadata->>'uid' AS uid, state.uidvalidity::text AS uid_validity
     FROM item_relations edge
     JOIN items folder ON folder.tenant_id = edge.tenant_id AND folder.deleted_at IS NULL
       AND folder.id = CASE WHEN edge.item_a = $1 THEN edge.item_b ELSE edge.item_a END
     LEFT JOIN mail_folder_sync_state state ON state.tenant_id = folder.tenant_id AND state.item_id = folder.id
     WHERE edge.tenant_id = app_tenant_default() AND edge.relation_definition_id = $2
       AND (edge.item_a = $1 OR edge.item_b = $1)
     ORDER BY edge.metadata->>'uid' IS NULL, folder.id`,
    [emailId, definition.id],
  );
  const edges: ImapFolderEdge[] = [];
  for (const row of rows) {
    // An edge that does not name a folder path and a UID the server could hold addresses nothing.
    const parsed = folderEdgeRow.safeParse(row);
    if (!parsed.success) continue;
    const uid = parsed.data.uid === null ? null : Number(parsed.data.uid);
    edges.push({
      path: parsed.data.path,
      uid: uid !== null && uid <= MAX_IMAP_UID ? uid : null,
      uidValidity: parsed.data.uid_validity,
    });
  }
  return edges;
}

/**
 * The locator of an `index` message of a live account. Refuses an account that is removed, has Mail off or waits for
 * the user to sign in again, without any provider call.
 */
export async function readMailMessageLocator(
  client: PoolClient,
  message: { emailId: string; mailboxItemId: string | null; messageId: string; providerMessageId: string | null },
): Promise<MailMessageLocator> {
  const ids = await resolveMailModuleIds(client);
  const mailbox =
    message.mailboxItemId === null ? null : await getItemById(client, ids.mailboxesDatabaseId, message.mailboxItemId);
  if (mailbox === null || mailbox.deletedAt) throw new MailContentUnavailableError("mailboxUnavailable");
  const state = await getMailAccountSyncState(client, mailbox.id);
  if (state === null || state.syncPausedAt !== null) throw new MailContentUnavailableError("mailboxUnavailable");
  if (state.lastFailureKind === "reauthorization") throw new MailContentUnavailableError("reauthorizationRequired");
  return {
    emailId: message.emailId,
    mailboxItemId: mailbox.id,
    syncMode: state.syncMode,
    mailboxProvider: typeof mailbox.properties.provider === "string" ? mailbox.properties.provider : undefined,
    connectionLimit: mailbox.properties.connectionLimit,
    messageId: message.messageId,
    providerMessageId: message.providerMessageId,
    imapEdges:
      state.syncMode === "imap" ? await readImapFolderEdges(client, ids.emailsDatabaseId, message.emailId) : [],
  };
}

interface EmailRow {
  body: string | null;
  content_state: string | null;
  message_id: string | null;
  provider_message_id: string | null;
  mailbox_item_id: string | null;
}

/** The live Emails item with its meta row; an unknown, foreign or trashed id is the 404 of a random id. */
export async function readLiveEmail(client: PoolClient, emailId: string): Promise<EmailRow> {
  const { emailsDatabaseId } = await resolveMailModuleIds(client);
  const { rows } = await client.query<EmailRow>(
    `SELECT CASE WHEN jsonb_typeof(i.properties->'body') = 'string' THEN i.properties->>'body' END AS body,
       m.content_state, m.message_id, m.provider_message_id, m.mailbox_item_id
     FROM items i
     LEFT JOIN mail_message_meta m ON m.tenant_id = i.tenant_id AND m.item_id = i.id
     WHERE i.tenant_id = app_tenant_default() AND i.database_id = $2 AND i.id = $1 AND i.deleted_at IS NULL`,
    [emailId, emailsDatabaseId],
  );
  const [row] = rows;
  if (!row) throw new NotFoundError("Message not found");
  return row;
}

/**
 * Runs a provider operation. The provider's refusal of the sign-in becomes `reauthorizationRequired`, an attachment
 * the client reports over `MAX_ATTACHMENT_BYTES` `attachmentTooLarge`; a database
 * failure (the OAuth token refresh reads and writes the credential row) keeps its identity; every other failure is a
 * provider failure of a fixed classification (the clients already replaced the original with a fixed error), logged
 * by name only and answered `providerUnreachable`.
 */
export async function providerPhase<T>(locator: MailMessageLocator, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof MailReauthorizationRequiredError)
      throw new MailContentUnavailableError("reauthorizationRequired");
    if (error instanceof AttachmentCapExceededError) throw new MailContentUnavailableError("attachmentTooLarge");
    if (error instanceof DatabaseError || error instanceof MailContentUnavailableError) throw error;
    logger.warn(
      {
        emailId: locator.emailId,
        mailboxItemId: locator.mailboxItemId,
        syncMode: locator.syncMode,
        errorName: error instanceof Error ? error.name : typeof error,
      },
      "A mail provider read on demand failed",
    );
    throw new MailContentUnavailableError("providerUnreachable");
  }
}

/**
 * Runs `work` on the account's IMAP client (its kept sync session, or a new connection under the connection limiter)
 * and hands the client back afterwards. The stored password is read with the user as the accessing actor.
 */
export async function withImapClient<T>(
  pool: Pool,
  providers: MailContentProviders,
  locator: MailMessageLocator,
  userId: string,
  work: (imap: ImapMailClient) => Promise<T>,
): Promise<T> {
  const create = providers.createImapClient;
  if (!create) throw new Error("No IMAP adapter configured for this composition root");
  const credential = await getDecryptedCredential(pool, {
    itemId: locator.mailboxItemId,
    actorType: "user",
    actorId: userId,
    purpose: "imap_content",
  });
  if (credential === null) throw new MailContentUnavailableError("reauthorizationRequired");
  const accountLimit = imapConnectionLimitForProvider(locator.mailboxProvider, locator.connectionLimit);
  const imap = await providerPhase(locator, () => create(locator.mailboxItemId, credential, accountLimit));
  try {
    return await work(imap);
  } finally {
    // The read's outcome is decided; a connection that fails to close is logged and changes nothing of it.
    try {
      await imap.close();
    } catch (error) {
      logger.warn(
        { mailboxItemId: locator.mailboxItemId, errorName: error instanceof Error ? error.name : typeof error },
        "Closing the IMAP connection of an on-demand read failed",
      );
    }
  }
}

/** A Message-ID the server can be searched for: printable ASCII without spaces, at most a header line long. */
const SEARCHABLE_MESSAGE_ID = /^[\x21-\x7e]{3,998}$/;

/** How many UIDs of one Message-ID search are tried. */
const MAX_SEARCH_CANDIDATES = 5;

/**
 * Finds the message on the IMAP server and reads it with `read`. Folder by folder (the edges with a UID first): the
 * edge's UID while the folder's UIDVALIDITY still equals the stored one, else (UID gone, UIDVALIDITY changed, edge
 * without UID) the UIDs `UID SEARCH HEADER Message-ID` finds in that folder. `null` when no folder holds it.
 */
export async function locateImapMessage<T>(
  imap: ImapMailClient,
  locator: MailMessageLocator,
  search: NonNullable<ImapMailClient["searchMessageId"]>,
  read: (path: string, uid: number) => Promise<T | null>,
): Promise<T | null> {
  for (const edge of locator.imapEdges) {
    const selection = await imap.selectFolder(edge.path);
    if (edge.uid !== null && edge.uidValidity === String(selection.uidvalidity)) {
      const found = await read(edge.path, edge.uid);
      if (found !== null) return found;
    }
    if (!SEARCHABLE_MESSAGE_ID.test(locator.messageId)) continue;
    for (const uid of (await search(edge.path, locator.messageId)).slice(0, MAX_SEARCH_CANDIDATES)) {
      const found = await read(edge.path, uid);
      if (found !== null) return found;
    }
  }
  return null;
}

/** The body as the provider holds it now; `null` when it no longer holds the message. Outside any transaction. */
async function fetchProviderBody(
  pool: Pool,
  providers: MailContentProviders,
  locator: MailMessageLocator,
  userId: string,
): Promise<ImapMessageBody | null> {
  if (locator.syncMode === "imap") {
    return withImapClient(pool, providers, locator, userId, (imap) => {
      const search = imap.searchMessageId?.bind(imap);
      const fetchBody = imap.fetchMessageBody?.bind(imap);
      if (!search || !fetchBody) throw new Error("The IMAP adapter of this composition root cannot read on demand");
      return providerPhase(locator, () => locateImapMessage(imap, locator, search, fetchBody));
    });
  }
  const providerMessageId = locator.providerMessageId;
  if (providerMessageId === null) return null;
  // The body parts the sync's full read gives; its attachment streams are lazy and never opened here.
  if (locator.syncMode === "gmail_api") {
    const create = providers.createGmailClient;
    if (!create) throw new Error("No Gmail adapter configured for this composition root");
    const fetched = await providerPhase(locator, () =>
      create(locator.mailboxItemId).fetchMessage(providerMessageId, "full"),
    );
    return fetched === null ? null : { bodyText: fetched.message.bodyText, bodyHtml: fetched.message.bodyHtml };
  }
  const create = providers.createGraphClient;
  if (!create) throw new Error("No Graph adapter configured for this composition root");
  const content = await providerPhase(locator, () =>
    create(locator.mailboxItemId).fetchMessageContent(providerMessageId),
  );
  return content === null ? null : { bodyText: content.bodyText, bodyHtml: content.bodyHtml };
}

/** In-process fetches of one message's body by tenant and Emails item id; concurrent readers share one. */
const inFlightFetches = new Map<string, Promise<MailContentCacheRow>>();

function flightKey(emailId: string): string {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new Error("An on-demand mail content read runs in a tenant scope");
  return `${scope.tenantId}:${emailId}`;
}

/** Fetches the body from the provider outside any transaction, then stores it as the message's cache row. */
async function fetchAndCacheBody(
  pool: Pool,
  providers: MailContentProviders,
  locator: MailMessageLocator,
  userId: string,
): Promise<MailContentCacheRow> {
  const body = await fetchProviderBody(pool, providers, locator, userId);
  if (body === null) throw new MailContentUnavailableError("messageNotFound");
  const cached = await withTransaction(pool, (client) =>
    writeMailContentCache(client, {
      itemId: locator.emailId,
      bodyHtml: body.bodyHtml ?? null,
      bodyText: body.bodyText ?? null,
    }),
  );
  // Trashed or purged while the provider answered: answered as an unknown id.
  if (cached === null) throw new NotFoundError("Message not found");
  return cached;
}

/** The message's body as `GET /api/mail/messages/:emailId/content` answers it. */
export interface MailMessageContent {
  emailId: string;
  /** `full`: the stored body; `cached`: the copy fetched from the provider (by this request or an earlier one). */
  contentState: "full" | "cached";
  bodyHtml: string;
  bodyText: string;
  /** When the provider copy was fetched and until when it is served; `null` for a stored body. */
  fetchedAt: string | null;
  expiresAt: string | null;
  /** As the thread detail lists them; an unstored one has no blob and no Files item until it is saved. */
  attachments: MailMessageAttachment[];
}

type ContentSource =
  | { kind: "full"; body: string }
  | { kind: "cached"; cache: MailContentCacheRow }
  | { kind: "remote"; locator: MailMessageLocator };

/** Where the body comes from, and the attachments, read in one transaction. */
async function readContentSource(
  client: PoolClient,
  emailId: string,
): Promise<{ source: ContentSource; attachments: MailMessageAttachment[] }> {
  const email = await readLiveEmail(client, emailId);
  const attachments = await readMailMessageAttachments(client, emailId);
  // A message without a meta row (a draft) and a `full` one store their body.
  if (email.content_state !== "index" || email.message_id === null)
    return { source: { kind: "full", body: email.body ?? "" }, attachments };
  const cache = await readFreshMailContentCache(client, emailId);
  if (cache !== null) return { source: { kind: "cached", cache }, attachments };
  const locator = await readMailMessageLocator(client, {
    emailId,
    mailboxItemId: email.mailbox_item_id,
    messageId: email.message_id,
    providerMessageId: email.provider_message_id,
  });
  return { source: { kind: "remote", locator }, attachments };
}

/**
 * A stored body as it is; for an `index` message an unexpired cache row, else a fetch from the provider whose result
 * becomes the cache row. The attachments are read with the body's source, before any provider call. Concurrent reads of one message in this process share one fetch, and a read that missed a
 * fetch that just ended finds its row; only a read that asks the provider is counted by the throttle.
 */
export async function readMailMessageContent(
  pool: Pool,
  dependencies: MailContentRouteDependencies,
  input: { emailId: string; userId: string; allowRemoteImages: boolean },
): Promise<MailMessageContent> {
  const { source, attachments } = await withTransaction(pool, (client) => readContentSource(client, input.emailId));
  const present = (contentState: "full" | "cached", raw: string, cache: MailContentCacheRow | null) => ({
    emailId: input.emailId,
    contentState,
    bodyHtml: sanitizeMailHtml(raw, { allowRemoteImages: input.allowRemoteImages }),
    bodyText: htmlToPlainText(raw),
    fetchedAt: cache?.fetchedAt.toISOString() ?? null,
    expiresAt: cache?.expiresAt.toISOString() ?? null,
    attachments,
  });
  // The cache holds both parts; the body served is chosen as ingest chooses `Emails.body`.
  const cachedBody = (cache: MailContentCacheRow) => cache.bodyHtml ?? cache.bodyText ?? "";
  if (source.kind === "full") return present("full", source.body, null);
  if (source.kind === "cached") return present("cached", cachedBody(source.cache), source.cache);

  const providers = requireMailContentDependency(dependencies, "mailContent");
  const key = flightKey(input.emailId);
  let flight = inFlightFetches.get(key);
  if (flight === undefined) {
    const started = (async () => {
      // A fetch that ended after this read's snapshot left its row: read it again before asking the provider.
      const fresh = await withTransaction(pool, (client) => readFreshMailContentCache(client, input.emailId));
      if (fresh !== null) return fresh;
      acquireMailContentFetch(dependencies, input.userId);
      return fetchAndCacheBody(pool, providers, source.locator, input.userId);
    })();
    flight = started.finally(() => inFlightFetches.delete(key));
    inFlightFetches.set(key, flight);
  }
  const cache = await flight;
  return present("cached", cachedBody(cache), cache);
}

/**
 * `GET /api/mail/messages/:emailId/content`. Remote images are an explicit opt-in as in the thread detail: only `true`
 * allows them, anything other than `false` or absent is a 400.
 */
export function createMailMessageContentRouteHandler(pool: Pool, dependencies: MailContentRouteDependencies) {
  return async (ctx: RouteParams & RouteUrl & RouteUser): Promise<CustomRouteResult<MailMessageContent>> => {
    const emailId = requireUuidParam(ctx.params, "emailId");
    const raw = requestUrl(ctx.req).searchParams.get("allowRemoteImages");
    if (raw !== null && raw !== "true" && raw !== "false")
      throw new ValidationError("Invalid allowRemoteImages", { field: "allowRemoteImages" });
    const body = await readMailMessageContent(pool, dependencies, {
      emailId,
      userId: ctx.identity.user.id,
      allowRemoteImages: raw === "true",
    });
    return { status: 200, body };
  };
}
