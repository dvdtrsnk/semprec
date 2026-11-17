import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { PoolClient } from "pg";
import { findOrCreateBlob, tenantBlobStorageKey } from "../blobs/blobsStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
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
export interface ClassifiedAttachment {
  filename: string;
  contentType: string;
  contentId: string | null;
  disposition: "attachment" | "inline";
  /** Lazily opens the decoded byte stream, so attachments are never buffered up front. Called once. */
  openStream(): Promise<Readable> | Readable;
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
        `INSERT INTO mail_attachments (message_item_id, blob_id, filename, content_type, content_id, disposition, byte_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.messageItemId,
          blob.id,
          attachment.filename,
          attachment.contentType,
          attachment.contentId,
          attachment.disposition,
          byteSize,
        ],
      );

      const fileItem = await createItemWithClient(client, {
        databaseId: input.filesDatabaseId,
        properties: { name: attachment.filename, file: { blobId: blob.id } },
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
      await createRelationWithClient(
        client,
        {
          relationPropertyId: threadAttachmentsPropertyId,
          callerItemId: input.threadItemId,
          targetItemId: fileItem.id,
        },
        EMAILS_RELATION_CONTEXT,
      );
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

/** Returns the number of rows deleted. Leaves the `blobs` rows and Files items in place. */
export async function deleteMailAttachmentsOfMessage(client: PoolClient, messageItemId: string): Promise<number> {
  const result = await client.query("DELETE FROM mail_attachments WHERE message_item_id = $1", [messageItemId]);
  return result.rowCount ?? 0;
}
