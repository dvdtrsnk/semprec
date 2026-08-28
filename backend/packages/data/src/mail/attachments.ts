import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { PoolClient } from "pg";
import { findOrCreateBlob } from "../blobs/blobsStore.js";
import { createItemWithClient, createRelationWithClient } from "../chokePoint/chokePoint.js";
import type { BlobStorageWriter } from "./blobStorage.js";
import { extractAttachmentText, isTextExtractableContentType } from "./attachmentTextExtraction.js";

/**
 * The shape every provider adapter (imap/gmail/graph) normalizes an attachment part down to.
 * "Belongs in Files" (issue #26) is the combination of `Content-Disposition: attachment` (has
 * a filename, meant to be downloaded) vs. `inline`, *together with* whether the part is
 * actually referenced via `cid:` inside the HTML body — an inline part with a matching `cid:`
 * reference is a rendering asset (a signature logo), not a document. Each adapter applies that
 * same rule itself while walking its own provider-specific MIME/part tree (imapFlowClient.ts's
 * `classifyAttachmentParts`, gmailRestClient.ts's `classifyGmailAttachmentParts`,
 * graphRestClient.ts's equivalent) — there is no shared parsed-message representation across
 * all three providers to classify generically from.
 */
export interface ClassifiedAttachment {
  filename: string;
  contentType: string;
  contentId: string | null;
  disposition: "attachment" | "inline";
  /**
   * Lazily opens the attachment's decoded byte stream — never a whole-message or whole-set-of-
   * attachments buffer already sitting in memory (issue #26: memory-safe attachment
   * processing). `ingestAttachments` below is the only caller, and calls this exactly once per
   * attachment, immediately before streaming it to storage.
   */
  openStream(): Promise<Readable> | Readable;
}

export interface IngestAttachmentsInput {
  messageItemId: string;
  filesDatabaseId: string;
  /** The Emails item's `attachments` relation property id — see seedEmailModule.ts. */
  attachmentsRelationPropertyId: string;
  attachments: ClassifiedAttachment[];
  storage: BlobStorageWriter;
  /** Namespacing prefix for storage keys, e.g. the mailbox item id — keeps different accounts' attachments from colliding on disk. */
  storageKeyPrefix: string;
}

/**
 * For every real attachment: writes its bytes through `storage` (streamed, see
 * blobStorage.ts), dedups the resulting blob by content hash, records a `mail_attachments`
 * row, and creates a Files item for it — "exactly like the mock already does today in
 * `sendEmailReply` for outgoing attachments," linked through the Emails `attachments`
 * relation so it shows up in the Files DB like any other file. Must run inside the same
 * transaction as the rest of message ingest (see mail/ingest.ts).
 */
/**
 * `attachment.filename` is attacker-controlled MIME header content — used verbatim as the
 * DB `filename`/display text (just rendered text, harmless), but a storage *key* becomes a
 * filesystem path component (see `LocalFsBlobStorageWriter`), where a name like
 * `../../etc/passwd` would escape the storage root. Strips path separators and traversal
 * sequences down to a safe basename before it ever reaches a storage key.
 */
function safeStorageFilename(filename: string): string {
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
  /** One entry per PDF/DOCX attachment that extraction actually produced text for (issue #26: "the output goes into the same index table") — folded into the message's own search text by ingest.ts, not indexed as a separate item. */
  extractedTexts: string[];
}

export async function ingestAttachments(client: PoolClient, input: IngestAttachmentsInput): Promise<IngestAttachmentsResult> {
  const extractedTexts: string[] = [];
  for (const attachment of input.attachments) {
    const storageKey = `${input.storageKeyPrefix}/${randomUUID()}-${safeStorageFilename(attachment.filename)}`;

    let source = await attachment.openStream();
    if (isTextExtractableContentType(attachment.contentType)) {
      // The one case this issue buffers an attachment's bytes in memory rather than pure-
      // streaming through to storage — extracting text needs the whole file, and every
      // attachment reaching here already passed the adapter's own MAX_ATTACHMENT_BYTES cap
      // (imapFlowClient.ts/gmailRestClient.ts/graphRestClient.ts), so this is bounded by the
      // same limit, not unbounded. Re-wrapped into a fresh stream afterward so the storage
      // write below still goes through the same `writeStream` path as every other attachment.
      const buffered = await bufferStream(source);
      // Best-effort: a corrupt/password-protected/malformed file must not fail the whole
      // message ingest over a search-indexing nicety.
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
    // A content-hash dedup hit means `blob` already existed under a different storageKey —
    // the bytes just streamed above are an unneeded duplicate on disk, not the ones kept.
    if (blob.storageKey !== storageKey) {
      await input.storage.delete(storageKey);
    }

    await client.query(
      `INSERT INTO mail_attachments (message_item_id, blob_id, filename, content_type, content_id, disposition, byte_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.messageItemId, blob.id, attachment.filename, attachment.contentType, attachment.contentId, attachment.disposition, byteSize],
    );

    const fileItem = await createItemWithClient(client, {
      databaseId: input.filesDatabaseId,
      properties: { name: attachment.filename, file: { blobId: blob.id } },
    });

    await createRelationWithClient(client, {
      relationPropertyId: input.attachmentsRelationPropertyId,
      itemId: input.messageItemId,
      targetItemId: fileItem.id,
    });
  }
  return { extractedTexts };
}
