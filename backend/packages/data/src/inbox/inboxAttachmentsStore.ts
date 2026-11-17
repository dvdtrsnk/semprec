import type { Queryable } from "../db/pool.js";
import { requireAffectedRows, requireSingleRow } from "../db/pool.js";
import type { PoolClient } from "pg";
import { filenameFromStorageKey } from "../blobs/blobMetadata.js";
import { deleteBlobIfUnreferenced, effectiveBlobMimeTypeSql, findOrCreateBlob } from "../blobs/blobsStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { triggerOnItemEventHeartbeats } from "../scheduler/schedulerStore.js";
import {
  attachmentExtractionSchema,
  classifyForExtraction,
  type AttachmentExtraction,
} from "./attachmentExtraction.js";
import { inboxAttachmentMetadataSchema, type InboxAttachmentMetadata } from "./inboxAttachmentMetadata.js";
import { lockInboxSource, lockInboxSourceIfPresent } from "./inboxSourceGuard.js";
import { enqueueJournalInboxRecomputeForInboxItem } from "./journalInboxCompute.js";

// `deleteBlobIfUnreferenced` counts these rows (and the derived `thumbnail_blob_id`/`reduced_blob_id`), so a blob's
// bytes stay while any attachment names it.

/** Must match the table's CHECK constraint. */
export type InboxAttachmentSource = "camera" | "scan" | "photoLibrary" | "files" | "share";

export interface NewInboxAttachment {
  blobId: string;
  source: InboxAttachmentSource;
}

/**
 * `mimeType` is the effective attachment type (`effectiveBlobMimeTypeSql`); `byteSize` is a string as on `BlobRow`.
 * `name` comes from the blob's storage key; only Files uploads write a key with a file name, so captured attachments
 * (bare uuid keys from `POST /api/blobs`) have `name: null`.
 */
export interface InboxAttachmentRow {
  attachmentId: string;
  inboxItemId: string;
  blobId: string;
  name: string | null;
  mimeType: string;
  byteSize: string;
  source: InboxAttachmentSource;
  position: number;
  metadata: InboxAttachmentMetadata | null;
  thumbnailBlobId: string | null;
  reducedBlobId: string | null;
  extraction: AttachmentExtraction | null;
}

interface InboxAttachmentDbRow {
  attachment_id: string;
  inbox_item_id: string;
  blob_id: string;
  storage_key: string;
  mime_type: string;
  byte_size: string;
  source: InboxAttachmentSource;
  position: number;
  metadata: unknown;
  thumbnail_blob_id: string | null;
  reduced_blob_id: string | null;
  extraction: unknown;
}

const ATTACHMENT_SELECT = `SELECT a.attachment_id, a.inbox_item_id, a.blob_id, b.storage_key, ${effectiveBlobMimeTypeSql("b")} AS mime_type, b.byte_size, a.source, a.position,
    a.metadata, a.thumbnail_blob_id, a.reduced_blob_id, a.extraction
  FROM inbox_attachments a
  JOIN blobs b ON b.tenant_id = a.tenant_id AND b.id = a.blob_id`;

function mapAttachmentRow(row: InboxAttachmentDbRow): InboxAttachmentRow {
  return {
    attachmentId: row.attachment_id,
    inboxItemId: row.inbox_item_id,
    blobId: row.blob_id,
    name: filenameFromStorageKey(row.storage_key),
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    source: row.source,
    position: row.position,
    // A JSONB column is a boundary: only the shape the metadata job writes is accepted.
    metadata: row.metadata === null ? null : inboxAttachmentMetadataSchema.parse(row.metadata),
    thumbnailBlobId: row.thumbnail_blob_id,
    reducedBlobId: row.reduced_blob_id,
    extraction: row.extraction === null ? null : attachmentExtractionSchema.parse(row.extraction),
  };
}

/**
 * The source lock serializes appenders and the position is read afterward. Another tenant's blob is refused by the
 * composite foreign key. The returned ids are not in the order of `attachments`. When rows were added, the Journal day
 * recompute is enqueued in the same transaction.
 */
export async function insertInboxAttachments(
  client: PoolClient,
  inboxItemId: string,
  attachments: NewInboxAttachment[],
): Promise<string[]> {
  await lockInboxSource(client, inboxItemId);
  const { rows } = await client.query<{ attachment_id: string }>(
    `INSERT INTO inbox_attachments (inbox_item_id, blob_id, position, source)
     SELECT $1::uuid, input.blob_id, (base.next_position + input.ordinal - 1)::integer, input.source
       FROM unnest($2::uuid[], $3::text[]) WITH ORDINALITY AS input(blob_id, source, ordinal)
       CROSS JOIN (
         SELECT COALESCE(MAX(position) + 1, 0) AS next_position
           FROM inbox_attachments WHERE inbox_item_id = $1::uuid
       ) AS base
     RETURNING attachment_id`,
    [
      inboxItemId,
      attachments.map((attachment) => attachment.blobId),
      attachments.map((attachment) => attachment.source),
    ],
  );
  if (rows.length > 0) await enqueueJournalInboxRecomputeForInboxItem(client, inboxItemId);
  return rows.map((row) => row.attachment_id);
}

export async function listInboxAttachments(client: Queryable, inboxItemIds: string[]): Promise<InboxAttachmentRow[]> {
  const { rows } = await client.query<InboxAttachmentDbRow>(
    `${ATTACHMENT_SELECT} WHERE a.inbox_item_id = ANY($1::uuid[]) ORDER BY a.inbox_item_id, a.position`,
    [inboxItemIds],
  );
  return rows.map(mapAttachmentRow);
}

export async function getInboxAttachment(client: Queryable, attachmentId: string): Promise<InboxAttachmentRow | null> {
  const { rows } = await client.query<InboxAttachmentDbRow>(`${ATTACHMENT_SELECT} WHERE a.attachment_id = $1`, [
    attachmentId,
  ]);
  return rows[0] ? mapAttachmentRow(rows[0]) : null;
}

export interface DeletedInboxAttachment {
  deleted: boolean;
  /** Derived blobs nothing references any more, to remove after the commit. */
  releasedStorageKeys: string[];
}

/**
 * The named blob is left to the caller. The derived images are released here through `deleteBlobIfUnreferenced`, so
 * one another attachment still names stays; their keys are returned for best-effort removal after the commit. A
 * derived blob deduplicated onto the attachment's own blob is not released. Enqueues the Journal day recompute when the
 * row existed.
 */
export async function deleteInboxAttachment(client: PoolClient, attachmentId: string): Promise<DeletedInboxAttachment> {
  const found = await client.query<{ inbox_item_id: string }>(
    "SELECT inbox_item_id FROM inbox_attachments WHERE attachment_id = $1",
    [attachmentId],
  );
  if (!found.rows[0]) return { deleted: false, releasedStorageKeys: [] };
  await lockInboxSource(client, found.rows[0].inbox_item_id, true);
  const result = await client.query<{
    blob_id: string;
    thumbnail_blob_id: string | null;
    reduced_blob_id: string | null;
  }>("DELETE FROM inbox_attachments WHERE attachment_id = $1 RETURNING blob_id, thumbnail_blob_id, reduced_blob_id", [
    attachmentId,
  ]);
  // Another transaction deleted the row between the read above and the source lock.
  if (result.rowCount === 0) return { deleted: false, releasedStorageKeys: [] };
  const row = requireSingleRow(result.rows, "deleted inbox attachment");
  await enqueueJournalInboxRecomputeForInboxItem(client, found.rows[0].inbox_item_id);
  const derivedIds = new Set(
    [row.thumbnail_blob_id, row.reduced_blob_id].flatMap((id) => (id === null || id === row.blob_id ? [] : [id])),
  );
  const releasedStorageKeys: string[] = [];
  for (const id of derivedIds) {
    const key = await deleteBlobIfUnreferenced(client, id);
    if (key !== null) releasedStorageKeys.push(key);
  }
  return { deleted: true, releasedStorageKeys };
}

/** Runs before the blobs are released, because a row still present would keep its blob referenced. */
export async function deleteInboxAttachmentsForItem(client: PoolClient, inboxItemId: string): Promise<string[]> {
  await lockInboxSourceIfPresent(client, inboxItemId, true);
  const result = await client.query<{
    blob_id: string;
    thumbnail_blob_id: string | null;
    reduced_blob_id: string | null;
  }>("DELETE FROM inbox_attachments WHERE inbox_item_id = $1 RETURNING blob_id, thumbnail_blob_id, reduced_blob_id", [
    inboxItemId,
  ]);
  if (result.rowCount === 0) return [];
  return result.rows.flatMap((row) =>
    [row.blob_id, row.thumbnail_blob_id, row.reduced_blob_id].filter((id): id is string => id !== null),
  );
}

export interface InboxAttachmentMetadataSource {
  attachmentId: string;
  mimeType: string;
  storageKey: string;
  /** A later run leaves written metadata alone. */
  metadataRecorded: boolean;
}

export async function readInboxAttachmentForMetadata(
  client: Queryable,
  attachmentId: string,
): Promise<InboxAttachmentMetadataSource | null> {
  const { rows } = await client.query<{
    attachment_id: string;
    mime_type: string;
    storage_key: string;
    metadata_recorded: boolean;
  }>(
    `SELECT a.attachment_id, ${effectiveBlobMimeTypeSql("b")} AS mime_type, b.storage_key, a.metadata IS NOT NULL AS metadata_recorded
       FROM inbox_attachments a
       JOIN blobs b ON b.tenant_id = a.tenant_id AND b.id = a.blob_id
      WHERE a.attachment_id = $1`,
    [attachmentId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    attachmentId: row.attachment_id,
    mimeType: row.mime_type,
    storageKey: row.storage_key,
    metadataRecorded: row.metadata_recorded,
  };
}

export interface DerivedImageBlob {
  mimeType: string;
  byteSize: number;
  storageKey: string;
  contentHash: string;
}

export interface RecordInboxAttachmentMetadataInput {
  attachmentId: string;
  metadata: InboxAttachmentMetadata;
  thumbnail: DerivedImageBlob | null;
  reduced: DerivedImageBlob | null;
}

/**
 * `recorded: false`: the attachment or item is gone, or another run already wrote metadata. `unusedStorageKeys` are
 * input keys no kept `blobs` row points at (deduplicated bytes), for the caller to remove; both keys when nothing was
 * recorded.
 */
export interface RecordedInboxAttachmentMetadata {
  recorded: boolean;
  unusedStorageKeys: string[];
}

/**
 * Writes once, then fires the source item's `onItemEvent` `update` heartbeats so a card computed before the facts is
 * recomputed (not for a trashed item). The source item is locked before the row, as in `deleteInboxAttachment`, so
 * `metadata IS NULL` is read under a lock and a concurrent run cannot be overwritten. Enqueues the Journal day
 * recompute when something was recorded. Derived blobs go through `findOrCreateBlob`, so existing bytes keep their blob.
 */
export async function recordInboxAttachmentMetadata(
  client: PoolClient,
  input: RecordInboxAttachmentMetadataInput,
): Promise<RecordedInboxAttachmentMetadata> {
  const metadata = inboxAttachmentMetadataSchema.parse(input.metadata);
  const derived = [input.thumbnail, input.reduced].filter((image): image is DerivedImageBlob => image !== null);
  const nothingRecorded = { recorded: false, unusedStorageKeys: derived.map((image) => image.storageKey) };
  const found = await client.query<{ inbox_item_id: string }>(
    "SELECT inbox_item_id FROM inbox_attachments WHERE attachment_id = $1",
    [input.attachmentId],
  );
  const inboxItemId = found.rows[0]?.inbox_item_id;
  if (inboxItemId === undefined) return nothingRecorded;
  if (!(await lockInboxSourceIfPresent(client, inboxItemId, true))) return nothingRecorded;
  const locked = await client.query<{ pending: boolean }>(
    "SELECT metadata IS NULL AS pending FROM inbox_attachments WHERE attachment_id = $1 FOR UPDATE",
    [input.attachmentId],
  );
  if (locked.rows[0]?.pending !== true) return nothingRecorded;

  const unusedStorageKeys: string[] = [];
  const blobIds = new Map<DerivedImageBlob, string>();
  for (const image of derived) {
    const blob = await findOrCreateBlob(client, image);
    blobIds.set(image, blob.id);
    if (blob.storageKey !== image.storageKey) unusedStorageKeys.push(image.storageKey);
  }
  const updated = await client.query(
    `UPDATE inbox_attachments SET metadata = $2::jsonb, thumbnail_blob_id = $3, reduced_blob_id = $4
      WHERE attachment_id = $1 AND metadata IS NULL`,
    [
      input.attachmentId,
      JSON.stringify(metadata),
      input.thumbnail ? (blobIds.get(input.thumbnail) ?? null) : null,
      input.reduced ? (blobIds.get(input.reduced) ?? null) : null,
    ],
  );
  requireAffectedRows(updated, `inbox attachment ${input.attachmentId} metadata`);
  await enqueueJournalInboxRecomputeForInboxItem(client, inboxItemId);

  const [source] = await getItemsByIds(client, [inboxItemId]);
  if (source && source.deletedAt === null) {
    await triggerOnItemEventHeartbeats(client, source.databaseId, "update", source.id);
  }
  return { recorded: true, unusedStorageKeys };
}

/** The tick waits for such an item; the metadata job's heartbeat starts it again. */
export async function hasAttachmentAwaitingMetadata(client: Queryable, inboxItemId: string): Promise<boolean> {
  const attachments = await listInboxAttachments(client, [inboxItemId]);
  return attachments.some((attachment) => classifyForExtraction(attachment) === "awaitingMetadata");
}

export interface RecordInboxAttachmentExtractionInput {
  attachmentId: string;
  /** A row of another item is not written. */
  inboxItemId: string;
  extraction: AttachmentExtraction;
}

/**
 * One `UPDATE ... WHERE extraction IS NULL`, so of two concurrent runs the loser matches no row and returns the
 * winner's value. `null` when the row is gone (deleted while the model was reading).
 */
export async function recordInboxAttachmentExtraction(
  client: Queryable,
  input: RecordInboxAttachmentExtractionInput,
): Promise<AttachmentExtraction | null> {
  const extraction = attachmentExtractionSchema.parse(input.extraction);
  const updated = await client.query(
    `UPDATE inbox_attachments SET extraction = $3::jsonb
      WHERE attachment_id = $1 AND inbox_item_id = $2 AND extraction IS NULL`,
    [input.attachmentId, input.inboxItemId, JSON.stringify(extraction)],
  );
  if (updated.rowCount === 1) return extraction;
  const { rows } = await client.query<{ extraction: unknown }>(
    "SELECT extraction FROM inbox_attachments WHERE attachment_id = $1 AND inbox_item_id = $2",
    [input.attachmentId, input.inboxItemId],
  );
  const stored = rows[0]?.extraction;
  return stored === undefined || stored === null ? null : attachmentExtractionSchema.parse(stored);
}
