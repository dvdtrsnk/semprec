import type { PoolClient } from "pg";
import { UnsupportedAttachmentTypeError, ValidationError } from "../errors.js";
import { lockBlobsForReference } from "../blobs/blobsStore.js";
import { UUID_RE } from "../docs/pageOwnerDatabase.js";
import { isAllowedInboxAttachmentMime } from "./attachmentTypes.js";
import { listInboxAttachments, type InboxAttachmentSource, type NewInboxAttachment } from "./inboxAttachmentsStore.js";

export const MAX_CAPTURE_ATTACHMENTS = 10;

const ATTACHMENT_SOURCES: readonly InboxAttachmentSource[] = ["camera", "scan", "photoLibrary", "files", "share"];

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
 * Every refusal, including a non-UUID blob id, is a `ValidationError` on `attachments`. Duplicate blob ids are
 * compared case-insensitively. Existence and type are checked by `requireAttachableBlobs`.
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
 * Locks the blobs against deletion until the transaction ends. A missing blob and another tenant's blob are the same
 * `ValidationError`.
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
