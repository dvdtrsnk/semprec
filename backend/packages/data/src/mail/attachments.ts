import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { PoolClient } from "pg";
import { findOrCreateBlob, tenantBlobStorageKey } from "../blobs/blobsStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import { requireAffectedRows } from "../db/pool.js";
import { NotFoundError } from "../errors.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { lockMailThreadMutation } from "./mailThreadMutationGuard.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import { EMAILS_RELATION_CONTEXT } from "./emailsRelationContext.js";
import { extractAttachmentText, isTextExtractableContentType } from "./attachmentTextExtraction.js";
import { AttachmentCapExceededError } from "./providerTypes.js";
import { logger } from "./logger.js";

/**
 * An attachment part as every provider adapter normalizes it. An inline part referenced via
 * `cid:` from the HTML body is a rendering asset (e.g. a signature logo), not a file; each
 * adapter applies that rule while walking its own MIME tree.
 */
export interface MailAttachmentPart {
  filename: string;
  contentType: string;
  contentId: string | null;
  disposition: "attachment" | "inline";
}

/** An attachment of a `full` message, whose bytes ingest stores. */
export interface ClassifiedAttachment extends MailAttachmentPart {
  /** Where the provider holds the bytes (the IMAP body part id); absent where the adapter records none. */
  providerPart?: string;
  /** Lazily opens the decoded byte stream, so attachments are never buffered up front. Called once. */
  openStream(): Promise<Readable> | Readable;
}

/** An attachment of an `index` message: its metadata only, the bytes left with the provider. */
export interface IndexedAttachment extends MailAttachmentPart {
  providerPart: string;
  /** The size the provider's body structure gives. */
  byteSize: number;
}

export interface IngestAttachmentsInput {
  messageItemId: string;
  /** `mail_threads.item_id`; the file gets a `Threads.attachments` edge from it. */
  threadItemId: string;
  filesDatabaseId: string;
  attachmentsRelationPropertyId: string;
  attachments: ClassifiedAttachment[];
  storage: BlobStorageWriter;
  /** Storage key prefix (e.g. the mailbox item id) so accounts do not collide on disk. */
  storageKeyPrefix: string;
}

/**
 * `filename` is attacker-controlled. It is fine as display text, but a storage key becomes a
 * filesystem path component, so separators and traversal sequences are stripped.
 */
export function safeStorageFilename(filename: string): string {
  const base = filename.replace(/^.*[/\\]/, "");
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return safe.length > 0 ? safe : "attachment";
}

async function bufferStream(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export interface IngestAttachmentsResult {
  /** Folded into the message's own search text, not indexed as separate items. */
  extractedTexts: string[];
}

async function requireThreadAttachmentsPropertyId(client: PoolClient): Promise<string> {
  const threads = await getDatabaseByModuleId(client, THREADS_MODULE_ID);
  const property = threads ? await getPropertyByKey(client, threads.id, "attachments") : null;
  if (!property) throw new Error("Threads.attachments is not seeded");
  return property.id;
}

/** The Files item of a stored attachment, linked from the Email (`attachments`) and the Thread (`Threads.attachments`). */
async function createAttachmentFileItem(
  client: PoolClient,
  input: {
    filesDatabaseId: string;
    attachmentsRelationPropertyId: string;
    threadAttachmentsPropertyId: string;
    messageItemId: string;
    /** `null` for a message in no thread: the file then has the Email's edge only. */
    threadItemId: string | null;
    filename: string;
    blobId: string;
  },
): Promise<string> {
  const fileItem = await createItemWithClient(client, {
    databaseId: input.filesDatabaseId,
    properties: { name: input.filename, file: { blobId: input.blobId } },
  });
  await createRelationWithClient(
    client,
    {
      relationPropertyId: input.attachmentsRelationPropertyId,
      callerItemId: input.messageItemId,
      targetItemId: fileItem.id,
    },
    EMAILS_RELATION_CONTEXT,
  );
  if (input.threadItemId !== null) {
    await createRelationWithClient(
      client,
      {
        relationPropertyId: input.threadAttachmentsPropertyId,
        callerItemId: input.threadItemId,
        targetItemId: fileItem.id,
      },
      EMAILS_RELATION_CONTEXT,
    );
  }
  return fileItem.id;
}

/**
 * Streams each attachment to storage, dedups the blob by content hash, records a
 * `mail_attachments` row and creates a Files item linked from the Email (`attachments`) and the
 * Thread (`Threads.attachments`). Must run in the message-ingest transaction.
 */
export async function ingestAttachments(
  client: PoolClient,
  input: IngestAttachmentsInput,
): Promise<IngestAttachmentsResult> {
  const extractedTexts: string[] = [];
  let threadAttachmentsPropertyId: string | undefined;
  for (const attachment of input.attachments) {
    // Before the bytes are written, so a tenant without the relation fails without a stored blob.
    threadAttachmentsPropertyId ??= await requireThreadAttachmentsPropertyId(client);
    const storageKey = await tenantBlobStorageKey(
      client,
      `${input.storageKeyPrefix}/${randomUUID()}-${safeStorageFilename(attachment.filename)}`,
    );

    try {
      let source = await attachment.openStream();
      if (isTextExtractableContentType(attachment.contentType)) {
        // Extraction needs the whole file in memory; bounded by the adapters' MAX_ATTACHMENT_BYTES.
        const buffered = await bufferStream(source);
        // Best-effort: a corrupt or encrypted file must not fail the ingest.
        const extractedText = await extractAttachmentText(attachment.contentType, buffered).catch(() => null);
        if (extractedText) extractedTexts.push(extractedText);
        source = Readable.from(buffered);
      }

      const { byteSize, contentHash } = await input.storage.writeStream(storageKey, source);

      const blob = await findOrCreateBlob(client, {
        mimeType: attachment.contentType,
        byteSize,
        storageKey,
        contentHash,
      });
      // Dedup hit: the bytes just written are a duplicate of an existing blob.
      if (blob.storageKey !== storageKey) {
        await input.storage.delete(storageKey);
      }

      await client.query(
        `INSERT INTO mail_attachments (message_item_id, blob_id, filename, content_type, content_id, disposition, byte_size,
                                       provider_part)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.messageItemId,
          blob.id,
          attachment.filename,
          attachment.contentType,
          attachment.contentId,
          attachment.disposition,
          byteSize,
          attachment.providerPart ?? null,
        ],
      );

      await createAttachmentFileItem(client, {
        filesDatabaseId: input.filesDatabaseId,
        attachmentsRelationPropertyId: input.attachmentsRelationPropertyId,
        threadAttachmentsPropertyId,
        messageItemId: input.messageItemId,
        threadItemId: input.threadItemId,
        filename: attachment.filename,
        blobId: blob.id,
      });
    } catch (err) {
      // An oversized attachment can surface from openStream() or as a stream error while it is
      // consumed, hence the wide try. Skip just this attachment.
      if (err instanceof AttachmentCapExceededError) {
        logger.warn(
          { messageItemId: input.messageItemId, contentType: attachment.contentType },
          "Skipping attachment that exceeded the size cap",
        );
        continue;
      }
      throw err;
    }
  }
  return { extractedTexts };
}

/**
 * Records each attachment of an index message as a `mail_attachments` row without bytes (`blob_id` NULL), keyed to
 * the provider's part, with no Files item and no `attachments` edge. Must run in the message-ingest transaction.
 */
export async function recordIndexedAttachments(
  client: PoolClient,
  messageItemId: string,
  attachments: readonly IndexedAttachment[],
): Promise<void> {
  if (attachments.length === 0) return;
  await client.query(
    `INSERT INTO mail_attachments (message_item_id, filename, content_type, content_id, disposition, byte_size, provider_part)
     SELECT $1::uuid, a.filename, a.content_type, a.content_id, a.disposition, a.byte_size, a.provider_part
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::text[])
         AS a(filename, content_type, content_id, disposition, byte_size, provider_part)`,
    [
      messageItemId,
      attachments.map((attachment) => attachment.filename),
      attachments.map((attachment) => attachment.contentType),
      attachments.map((attachment) => attachment.contentId),
      attachments.map((attachment) => attachment.disposition),
      attachments.map((attachment) => attachment.byteSize),
      attachments.map((attachment) => attachment.providerPart),
    ],
  );
}

/** The live Files item the Email links over `attachments` for a stored attachment (same blob and name), if any. */
export async function findAttachmentFileItem(
  client: PoolClient,
  input: { messageItemId: string; blobId: string; filename: string },
): Promise<string | null> {
  const { emailsDatabaseId, filesDatabaseId } = await resolveMailModuleIds(client);
  const property = await getPropertyByKey(client, emailsDatabaseId, "attachments");
  const definition = property ? await getRelationDefinitionByPropertyId(client, property.id) : null;
  if (!definition) throw new Error("Emails.attachments is not seeded");
  const { rows } = await client.query<{ id: string }>(
    `SELECT file.id FROM item_relations edge
     JOIN items file ON file.tenant_id = edge.tenant_id AND file.database_id = $3 AND file.deleted_at IS NULL
       AND file.id = CASE WHEN edge.item_a = $1 THEN edge.item_b ELSE edge.item_a END
     WHERE edge.tenant_id = app_tenant_default() AND edge.relation_definition_id = $2
       AND (edge.item_a = $1 OR edge.item_b = $1)
       AND file.properties->'file'->>'blobId' = $4 AND file.properties->>'name' = $5
     ORDER BY file.id LIMIT 1`,
    [input.messageItemId, definition.id, filesDatabaseId, input.blobId, input.filename],
  );
  return rows[0]?.id ?? null;
}

/** Bytes of an attachment written to storage before the transaction that records them. */
export interface FetchedAttachmentBytes {
  storageKey: string;
  byteSize: number;
  contentHash: string;
}

/**
 * Saves one attachment of a message into Files, as the full ingest stores an attachment: under the tenant's mail-thread
 * guard, then the `mail_attachments` row locked, a row without bytes gets the blob of `fetched` (deduplicated by
 * content hash) and its stored size; then the Email's live Files item over the same blob and name is returned, or one
 * is created with the `Emails.attachments` and `Threads.attachments` edges. Concurrent saves of one attachment queue
 * on the row lock, so the second finds what the first wrote. `fetchedKeyUsed` is false when the bytes at
 * `fetched.storageKey` are not referenced (a duplicate blob, or bytes another save stored first), so the caller
 * deletes them. 404 when the attachment or its live Email is gone.
 */
export async function saveMailAttachmentFile(
  client: PoolClient,
  input: { messageItemId: string; attachmentId: string; fetched: FetchedAttachmentBytes | null },
): Promise<{ fileItemId: string; fetchedKeyUsed: boolean }> {
  await lockMailThreadMutation(client);
  const { emailsDatabaseId, filesDatabaseId } = await resolveMailModuleIds(client);
  const { rows } = await client.query<{
    blob_id: string | null;
    filename: string;
    content_type: string;
    thread_item_id: string | null;
  }>(
    `SELECT a.blob_id, a.filename, a.content_type, thread.item_id AS thread_item_id
     FROM mail_attachments a
     JOIN items email ON email.tenant_id = a.tenant_id AND email.id = a.message_item_id AND email.database_id = $3
       AND email.deleted_at IS NULL
     LEFT JOIN mail_message_meta meta ON meta.tenant_id = a.tenant_id AND meta.item_id = email.id
     LEFT JOIN mail_threads thread ON thread.tenant_id = a.tenant_id AND thread.id = meta.thread_id
     WHERE a.tenant_id = app_tenant_default() AND a.id = $1 AND a.message_item_id = $2
     FOR UPDATE OF a`,
    [input.attachmentId, input.messageItemId, emailsDatabaseId],
  );
  const [row] = rows;
  if (!row) throw new NotFoundError("Attachment not found");
  let blobId = row.blob_id;
  let fetchedKeyUsed = false;
  if (blobId === null) {
    // The reader saw no blob, so it fetched the bytes; nothing sets a stored blob back to none.
    if (input.fetched === null) throw new Error("A mail attachment without bytes was saved without fetching them");
    const blob = await findOrCreateBlob(client, {
      mimeType: row.content_type,
      byteSize: input.fetched.byteSize,
      storageKey: input.fetched.storageKey,
      contentHash: input.fetched.contentHash,
    });
    fetchedKeyUsed = blob.storageKey === input.fetched.storageKey;
    requireAffectedRows(
      await client.query(
        `UPDATE mail_attachments SET blob_id = $2, byte_size = $3
          WHERE tenant_id = app_tenant_default() AND id = $1 AND blob_id IS NULL`,
        [input.attachmentId, blob.id, input.fetched.byteSize],
      ),
      "mail_attachments row locked without a blob",
    );
    blobId = blob.id;
  }
  const existing = await findAttachmentFileItem(client, {
    messageItemId: input.messageItemId,
    blobId,
    filename: row.filename,
  });
  if (existing !== null) return { fileItemId: existing, fetchedKeyUsed };
  const attachmentsProperty = await getPropertyByKey(client, emailsDatabaseId, "attachments");
  if (!attachmentsProperty) throw new Error("Emails.attachments is not seeded");
  const fileItemId = await createAttachmentFileItem(client, {
    filesDatabaseId,
    attachmentsRelationPropertyId: attachmentsProperty.id,
    threadAttachmentsPropertyId: await requireThreadAttachmentsPropertyId(client),
    messageItemId: input.messageItemId,
    threadItemId: row.thread_item_id,
    filename: row.filename,
    blobId,
  });
  return { fileItemId, fetchedKeyUsed };
}
