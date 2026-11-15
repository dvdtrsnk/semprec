import type { PoolClient } from "pg";
import { UnsupportedAttachmentTypeError, ValidationError } from "../errors.js";
import { lockBlobsForReference } from "../blobs/blobsStore.js";
import { UUID_RE } from "../docs/pageOwnerDatabase.js";
import { isAllowedInboxAttachmentMime } from "./attachmentTypes.js";
import { listInboxAttachments, type InboxAttachmentSource, type NewInboxAttachment } from "./inboxAttachmentsStore.js";

// The attachments of `POST /api/inbox/items` (issue gh-1963): the shape of the body's `attachments`, the check that
// every named blob may be attached, and the list the capture answers with.

/** The most attachments one capture may carry. */
export const MAX_CAPTURE_ATTACHMENTS = 10;

const ATTACHMENT_SOURCES: readonly InboxAttachmentSource[] = ["camera", "scan", "photoLibrary", "files", "share"];

/** One attachment as the capture answers with it. `byteSize` is a number, as in the answer of `POST /api/blobs`. */
export interface CaptureAttachmentResponse {
  attachmentId: string;
  blobId: string;
  mimeType: string;
  byteSize: number;
  source: InboxAttachmentSource;
}

function isAttachmentSource(value: unknown): value is InboxAttachmentSource {
  return typeof value === "string" && ATTACHMENT_SOURCES.some((source) => source === value);
}

function invalidAttachments(message: string): ValidationError {
  return new ValidationError(message, { field: "attachments" });
}

/**
 * The `attachments` of a capture body: absent means none, otherwise an array of at most `MAX_CAPTURE_ATTACHMENTS`
 * objects holding exactly a UUID string `blobId` and a `source` of the five values, no blob named twice (compared
 * case-insensitively). Every refusal is a `ValidationError` on `attachments`, as is a blob id that is not a UUID, which
 * no blob can have. Whether a blob exists and may be attached is `requireAttachableBlobs`'s question.
 */
export function parseCaptureAttachments(value: unknown): NewInboxAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidAttachments("'attachments' must be an array");
  if (value.length > MAX_CAPTURE_ATTACHMENTS) {
    throw invalidAttachments(`'attachments' holds at most ${MAX_CAPTURE_ATTACHMENTS} entries`);
  }
  const seen = new Set<string>();
  return value.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw invalidAttachments("Each attachment must be a JSON object");
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "blobId" && key !== "source") throw invalidAttachments(`Unknown attachment field '${key}'`);
    }
    const { blobId, source } = record;
    if (typeof blobId !== "string" || !UUID_RE.test(blobId)) {
      throw invalidAttachments("Each attachment needs a 'blobId' that names a blob");
    }
    if (!isAttachmentSource(source)) {
      throw invalidAttachments(`Each attachment needs a 'source' of ${ATTACHMENT_SOURCES.join(", ")}`);
    }
    const normalized = blobId.toLowerCase();
    if (seen.has(normalized)) throw invalidAttachments("A blob can be attached only once to a capture");
    seen.add(normalized);
    return { blobId: normalized, source };
  });
}

/**
 * Checks, in the caller's transaction and in the order given, that each attachment names a blob of the caller's tenant
 * and that its stored mime type is one an Inbox attachment may have, and keeps those blobs from being deleted until
 * the transaction ends. A blob that does not exist and one of another tenant are the same `ValidationError` on
 * `attachments`; a blob of a type outside the list is an `UnsupportedAttachmentTypeError` naming it.
 */
export async function requireAttachableBlobs(client: PoolClient, attachments: NewInboxAttachment[]): Promise<void> {
  if (attachments.length === 0) return;
  const blobs = await lockBlobsForReference(
    client,
    attachments.map((attachment) => attachment.blobId),
  );
  const mimeTypeById = new Map(blobs.map((blob) => [blob.id, blob.mimeType]));
  for (const { blobId } of attachments) {
    const mimeType = mimeTypeById.get(blobId);
    if (mimeType === undefined) throw invalidAttachments("An attachment names a blob that does not exist");
    if (!isAllowedInboxAttachmentMime(mimeType)) throw new UnsupportedAttachmentTypeError({ blobId, mimeType });
  }
}

/** The attachments of one Inbox item in their order, as the capture answers with them. */
export async function readCaptureAttachments(
  client: PoolClient,
  inboxItemId: string,
): Promise<CaptureAttachmentResponse[]> {
  const rows = await listInboxAttachments(client, [inboxItemId]);
  return rows.map((row) => ({
    attachmentId: row.attachmentId,
    blobId: row.blobId,
    mimeType: row.mimeType,
    byteSize: Number(row.byteSize),
    source: row.source,
  }));
}
