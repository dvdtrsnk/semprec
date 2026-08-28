import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { PoolClient } from "pg";
import type { ParsedMail } from "mailparser";
import { findOrCreateBlob } from "../blobs/blobsStore.js";
import { createItemWithClient, createRelationWithClient } from "../chokePoint/chokePoint.js";
import type { BlobStorageWriter } from "./blobStorage.js";

export interface ClassifiedAttachment {
  filename: string;
  contentType: string;
  contentId: string | null;
  disposition: "attachment" | "inline";
  /**
   * Lazily opens the attachment's decoded byte stream. Deliberately not a `Buffer`: a provider
   * adapter that already has the whole part in memory (mailparser's parsed output, below) can
   * still wrap it in one, but the IMAP adapter (imapFlowClient.ts) streams straight from the
   * socket via imapflow's `download()` and never buffers the part whole — the issue's
   * "memory-safe attachment processing" requirement. `ingestAttachments` below is the only
   * caller, and calls this exactly once per attachment, immediately before streaming it to
   * storage.
   */
  openStream(): Promise<Readable> | Readable;
}

/**
 * MIME classification (issue #26) for a provider that already handed us the fully-parsed
 * message (Gmail's REST client only — see gmailRestClient.ts's own note on why the Gmail API
 * doesn't allow the IMAP adapter's part-by-part streaming approach): "belongs in Files" is the
 * combination of `Content-Disposition: attachment` (has a filename, meant to be downloaded)
 * vs. `inline`, *together with* whether the part is actually referenced via `cid:` inside the
 * HTML body — an inline part with a matching `cid:` reference is a rendering asset (a
 * signature logo), not a document, and is excluded here. `mailparser`'s own `attachments`
 * array already includes both kinds undifferentiated; this is the extra filter the issue
 * calls for.
 */
export function classifyAttachments(parsed: ParsedMail): ClassifiedAttachment[] {
  const html = typeof parsed.html === "string" ? parsed.html : "";
  const result: ClassifiedAttachment[] = [];
  for (const part of parsed.attachments ?? []) {
    const disposition: "attachment" | "inline" = part.contentDisposition === "inline" ? "inline" : "attachment";
    const contentId = part.cid ?? null;
    const referencedInline = disposition === "inline" && contentId !== null && html.includes(`cid:${contentId}`);
    if (referencedInline) continue;
    result.push({
      filename: part.filename ?? "attachment",
      contentType: part.contentType,
      contentId,
      disposition,
      // mailparser already fully materialized this part's bytes while parsing the message
      // (see gmailRestClient.ts) — Readable.from wraps the existing buffer, it does not
      // re-buffer anything.
      openStream: () => Readable.from(part.content),
    });
  }
  return result;
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

export async function ingestAttachments(client: PoolClient, input: IngestAttachmentsInput): Promise<void> {
  for (const attachment of input.attachments) {
    const storageKey = `${input.storageKeyPrefix}/${randomUUID()}-${safeStorageFilename(attachment.filename)}`;
    const { byteSize, contentHash } = await input.storage.writeStream(storageKey, await attachment.openStream());

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
}
