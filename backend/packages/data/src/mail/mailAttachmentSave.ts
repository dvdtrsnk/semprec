import { randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import type { Pool, PoolClient } from "pg";
import { tenantBlobStorageKey } from "../blobs/blobsStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import type { CustomRouteResult, RouteParams, RouteUser } from "../customRoute.js";
import { requireUuidParam } from "../customRoute.js";
import {
  findAttachmentFileItem,
  safeStorageFilename,
  saveMailAttachmentFile,
  type FetchedAttachmentBytes,
} from "./attachments.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import {
  acquireMailContentFetch,
  locateImapMessage,
  MailContentUnavailableError,
  providerPhase,
  readLiveEmail,
  readMailMessageLocator,
  requireMailContentDependency,
  withImapClient,
  type MailContentProviders,
  type MailContentRouteDependencies,
  type MailMessageLocator,
  type MailProviderAccess,
} from "./mailMessageContent.js";
import { AttachmentCapExceededError } from "./providerTypes.js";
import { logger } from "./logger.js";

/** A provider stream that sends nothing for this long fails the save. */
const ATTACHMENT_STREAM_IDLE_TIMEOUT_MS = 60_000;

/** The provider's byte stream failed (or stalled); `capExceeded` when it was over `MAX_ATTACHMENT_BYTES`. */
class ProviderStreamFailure extends Error {
  constructor(readonly capExceeded: boolean) {
    super("The mail provider's attachment stream failed");
    this.name = "ProviderStreamFailure";
  }
}

/**
 * Passes the provider's bytes on and tags its failure (or a stall of `ATTACHMENT_STREAM_IDLE_TIMEOUT_MS`) as
 * `ProviderStreamFailure`, so a storage failure keeps its own identity. A consumer that stops early destroys the source,
 * which leaves an IMAP connection not reusable.
 */
function guardProviderStream(source: Readable): Readable {
  const guarded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      timer.refresh();
      callback(null, chunk);
    },
  });
  const timer = setTimeout(() => guarded.destroy(new ProviderStreamFailure(false)), ATTACHMENT_STREAM_IDLE_TIMEOUT_MS);
  source.on("error", (error: unknown) => {
    guarded.destroy(new ProviderStreamFailure(error instanceof AttachmentCapExceededError));
  });
  guarded.once("close", () => {
    clearTimeout(timer);
    if (!source.destroyed) source.destroy();
  });
  source.pipe(guarded);
  return guarded;
}

/**
 * Writes the provider's bytes at `storageKey`; a provider failure removes what was written and is answered 409. A
 * storage write that fails before the stream's end leaves the provider's download running: it is destroyed, and its
 * close marks an IMAP connection not reusable, before the client is handed back.
 */
async function storeProviderBytes(
  storage: BlobStorageWriter,
  storageKey: string,
  source: Readable,
): Promise<FetchedAttachmentBytes> {
  const guarded = guardProviderStream(source);
  try {
    const written = await storage.writeStream(storageKey, guarded);
    return { storageKey, ...written };
  } catch (error) {
    guarded.destroy();
    source.destroy();
    if (!source.closed) await new Promise<void>((resolve) => source.once("close", () => resolve()));
    await deleteStoredBytes(storage, storageKey);
    if (error instanceof ProviderStreamFailure)
      throw new MailContentUnavailableError(error.capExceeded ? "attachmentTooLarge" : "providerUnreachable");
    throw error;
  }
}

/** Best effort: a failed removal is logged and leaves an unreferenced file, never replacing the save's outcome. */
async function deleteStoredBytes(storage: BlobStorageWriter, storageKey: string): Promise<void> {
  try {
    await storage.delete(storageKey);
  } catch (error) {
    logger.warn(
      { errorName: error instanceof Error ? error.name : typeof error },
      "Removing unreferenced attachment bytes failed",
    );
  }
}

interface AttachmentToFetch {
  locator: MailMessageLocator;
  providerPart: string;
  filename: string;
  storageKey: string;
}

type AttachmentSource = { kind: "stored"; fileItemId: string | null } | { kind: "remote"; fetch: AttachmentToFetch };

/** An IMAP body part id (`2`, `1.3`): what the light fetch records as an attachment's part. */
const IMAP_PART = /^[1-9]\d{0,3}(\.[1-9]\d{0,3}){0,19}$/;

async function readAttachmentSource(client: PoolClient, emailId: string, attachmentId: string) {
  const email = await readLiveEmail(client, emailId);
  const { rows } = await client.query<{ blob_id: string | null; provider_part: string | null; filename: string }>(
    `SELECT blob_id, provider_part, filename FROM mail_attachments
      WHERE tenant_id = app_tenant_default() AND id = $1 AND message_item_id = $2`,
    [attachmentId, emailId],
  );
  const [attachment] = rows;
  if (!attachment) throw new NotFoundError("Attachment not found");
  if (attachment.blob_id !== null) {
    const fileItemId = await findAttachmentFileItem(client, {
      messageItemId: emailId,
      blobId: attachment.blob_id,
      filename: attachment.filename,
    });
    return { kind: "stored", fileItemId } satisfies AttachmentSource;
  }
  // A row without bytes records where the provider holds them (`mail_attachments_stored_or_located_check`).
  if (attachment.provider_part === null || email.message_id === null)
    throw new Error("A mail attachment without bytes records no provider part");
  const locator = await readMailMessageLocator(client, {
    emailId,
    mailboxItemId: email.mailbox_item_id,
    messageId: email.message_id,
    providerMessageId: email.provider_message_id,
  });
  if (locator.syncMode === "imap" && !IMAP_PART.test(attachment.provider_part))
    throw new MailContentUnavailableError("messageNotFound");
  return {
    kind: "remote",
    fetch: {
      locator,
      providerPart: attachment.provider_part,
      filename: attachment.filename,
      storageKey: await tenantBlobStorageKey(
        client,
        `${locator.mailboxItemId}/${randomUUID()}-${safeStorageFilename(attachment.filename)}`,
      ),
    },
  } satisfies AttachmentSource;
}

/** The attachment's bytes from the provider into storage, outside any transaction. */
async function fetchAttachmentBytes(
  pool: Pool,
  providers: MailContentProviders,
  storage: BlobStorageWriter,
  fetch: AttachmentToFetch,
  userId: string,
): Promise<FetchedAttachmentBytes> {
  const { locator, providerPart, filename, storageKey } = fetch;
  if (locator.syncMode === "imap") {
    return withImapClient(pool, providers, locator, userId, async (imap) => {
      const search = imap.searchMessageId?.bind(imap);
      const downloadPart = imap.downloadPart?.bind(imap);
      if (!search || !downloadPart) throw new Error("The IMAP adapter of this composition root cannot read on demand");
      const source = await providerPhase(locator, () =>
        locateImapMessage(imap, locator, search, (path, uid) => downloadPart(path, uid, providerPart)),
      );
      if (source === null) throw new MailContentUnavailableError("messageNotFound");
      // Consumed while the client is checked out: the stream reads its connection.
      return storeProviderBytes(storage, storageKey, source);
    });
  }
  const providerMessageId = locator.providerMessageId;
  if (providerMessageId === null) throw new MailContentUnavailableError("messageNotFound");
  const access: MailProviderAccess = { actor: { actorType: "user", actorId: userId }, use: "content" };
  let source: Readable | null;
  if (locator.syncMode === "gmail_api") {
    const create = providers.createGmailClient;
    if (!create) throw new Error("No Gmail adapter configured for this composition root");
    source = await providerPhase(locator, () =>
      create(locator.mailboxItemId, access).openAttachmentContent(providerMessageId, providerPart, filename),
    );
  } else {
    const create = providers.createGraphClient;
    if (!create) throw new Error("No Graph adapter configured for this composition root");
    source = await providerPhase(locator, () =>
      create(locator.mailboxItemId, access).openAttachmentContent(providerMessageId, providerPart),
    );
  }
  if (source === null) throw new MailContentUnavailableError("messageNotFound");
  return storeProviderBytes(storage, storageKey, source);
}

/**
 * Saves an attachment into the user's Files. Stored bytes need no provider; otherwise the bytes are fetched (one
 * counted fetch of the user) and written to storage before the transaction, which records them as the full ingest
 * does. Saving the same attachment again answers its existing Files item.
 */
export async function saveMailAttachment(
  pool: Pool,
  dependencies: MailContentRouteDependencies,
  input: { emailId: string; attachmentId: string; userId: string },
): Promise<{ fileItemId: string }> {
  const source = await withTransaction(pool, (client) =>
    readAttachmentSource(client, input.emailId, input.attachmentId),
  );
  if (source.kind === "stored" && source.fileItemId !== null) return { fileItemId: source.fileItemId };
  let fetched: FetchedAttachmentBytes | null = null;
  let storage: BlobStorageWriter | null = null;
  if (source.kind === "remote") {
    const providers = requireMailContentDependency(dependencies, "mailContent");
    const attachmentStorage = providers.attachmentStorage;
    if (!attachmentStorage)
      throw new Error('custom route dependency "mailContent.attachmentStorage" is not configured');
    storage = attachmentStorage;
    acquireMailContentFetch(dependencies, input.userId);
    fetched = await fetchAttachmentBytes(pool, providers, attachmentStorage, source.fetch, input.userId);
  }
  let saved: { fileItemId: string; fetchedKeyUsed: boolean };
  try {
    saved = await withTransaction(pool, (client) =>
      saveMailAttachmentFile(client, { messageItemId: input.emailId, attachmentId: input.attachmentId, fetched }),
    );
  } catch (error) {
    if (fetched !== null && storage !== null) await deleteStoredBytes(storage, fetched.storageKey);
    throw error;
  }
  if (fetched !== null && storage !== null && !saved.fetchedKeyUsed)
    await deleteStoredBytes(storage, fetched.storageKey);
  return { fileItemId: saved.fileItemId };
}

/** `POST /api/mail/messages/:emailId/attachments/:attachmentId/save`: `{ fileItemId }` of the saved Files item. */
export function createMailAttachmentSaveRouteHandler(pool: Pool, dependencies: MailContentRouteDependencies) {
  return async (ctx: RouteParams & RouteUser): Promise<CustomRouteResult<{ fileItemId: string }>> => {
    const emailId = requireUuidParam(ctx.params, "emailId");
    const attachmentId = requireUuidParam(ctx.params, "attachmentId");
    return {
      status: 200,
      body: await saveMailAttachment(pool, dependencies, { emailId, attachmentId, userId: ctx.identity.user.id }),
    };
  };
}
