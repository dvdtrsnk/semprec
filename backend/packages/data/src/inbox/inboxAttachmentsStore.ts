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

// Owns the `inbox_attachments` table: the files an Inbox item carries (issue #1564). Moving them into
// Files on confirm is issue #1703, and is not done here. Each row names one `blobs` row, and
// `deleteBlobIfUnreferenced` counts these rows, so the bytes of a blob stay while any attachment names it. A row also
// holds the facts `semprec-transcribe` computed for it (issue gh-1965): `metadata` and the two derived images of a
// photo, `thumbnail_blob_id` and `reduced_blob_id`, which are counted references to `blobs` as well. `extraction` is
// the document data the assistant read off a photo (issue gh-1970), written once by the API runtime.

/** Where an attachment was taken from; the table's CHECK constraint accepts exactly these values. */
export type InboxAttachmentSource = "camera" | "scan" | "photoLibrary" | "files" | "share";

/** One attachment to append to an Inbox item: the uploaded blob it names and where it came from. */
export interface NewInboxAttachment {
  blobId: string;
  source: InboxAttachmentSource;
}

/**
 * An attachment joined with the blob it names. `mimeType` is the type the blob has as an attachment
 * (`effectiveBlobMimeTypeSql`); `byteSize` is a string, as `BlobRow.byteSize` is. `metadata` is what the metadata job
 * found, and `null` until it has run; `thumbnailBlobId` and `reducedBlobId` are the derived images of a photo the job
 * could read, and `null` otherwise. `extraction` is what the assistant read off the reduced copy, `null` until the
 * proposal computation stored it. `name` is the file name an upload recorded in the blob's storage key
 * (`filenameFromStorageKey`), and `null` for a blob stored without one: no attachment row has a name of its own. Only a
 * Files upload (`ingestUploadedFile`) writes a key with a file name. A blob made by `POST /api/blobs`
 * (`ingestUploadedBlob`), which is what a capture attaches, has a bare uuid key, so the `name` of every attachment
 * captured that way is `null` today.
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
 * Appends `attachments` to an Inbox item in the order given, after the item's highest position (the
 * first one takes 0). The source lock serializes appenders and the position is read afterward.
 * A blob of another tenant is refused by the composite foreign key to `blobs`. Returns the ids of the new rows,
 * which a caller enqueueing work per attachment needs (the order is not that of `attachments`). When rows were added, the
 * recompute of the Journal day that lists the Inbox item is enqueued in the same transaction (issue gh-1969), so the
 * day's summary shows the new attachments; an empty list adds no row and enqueues nothing.
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

/** The attachments of the given Inbox items, joined with their blobs, ordered by item and then position. */
export async function listInboxAttachments(client: Queryable, inboxItemIds: string[]): Promise<InboxAttachmentRow[]> {
  const { rows } = await client.query<InboxAttachmentDbRow>(
    `${ATTACHMENT_SELECT} WHERE a.inbox_item_id = ANY($1::uuid[]) ORDER BY a.inbox_item_id, a.position`,
    [inboxItemIds],
  );
  return rows.map(mapAttachmentRow);
}

/** One attachment by id, joined with its blob, or null when this tenant has no such row. */
export async function getInboxAttachment(client: Queryable, attachmentId: string): Promise<InboxAttachmentRow | null> {
  const { rows } = await client.query<InboxAttachmentDbRow>(`${ATTACHMENT_SELECT} WHERE a.attachment_id = $1`, [
    attachmentId,
  ]);
  return rows[0] ? mapAttachmentRow(rows[0]) : null;
}

/** What `deleteInboxAttachment` did: whether the row existed, and the bytes of the derived images it freed. */
export interface DeletedInboxAttachment {
  deleted: boolean;
  /** `storage_key` of every derived blob (preview, reduced copy) that nothing references any more, to remove after the commit. */
  releasedStorageKeys: string[];
}

/**
 * Removes one attachment row and reports whether it existed. The blob it named is left alone: a caller
 * that drops the last reference to a blob releases its bytes through `deleteBlobIfUnreferenced`. The derived images of
 * the row (`thumbnail_blob_id`, `reduced_blob_id`) are released here, in the caller's transaction, through
 * `deleteBlobIfUnreferenced`, so a derived blob another attachment still names stays. Their `storage_key`s are returned
 * for the caller to remove after the commit (`2026-09-28-blob-bytes-deleted-best-effort-after-the-commit`). A derived
 * blob that is the attachment's own blob (identical bytes deduplicated onto it) is not released. When the row existed, the
 * recompute of the Journal day that lists the Inbox item is enqueued in the same transaction (issue gh-1969), so the day's
 * summary drops the attachment, whether it was removed or moved into Files.
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

/**
 * Removes every attachment row of a permanently deleted Inbox item and returns the blob ids those rows
 * named, the derived images included. `deleteItemDependents` runs it before releasing those blobs, because a row still
 * present would keep its blob referenced.
 */
export async function deleteInboxAttachmentsForItem(client: PoolClient, inboxItemId: string): Promise<string[]> {
  await lockInboxSourceIfPresent(client, inboxItemId, true);
  const result = await client.query<{
    blob_id: string;
    thumbnail_blob_id: string | null;
    reduced_blob_id: string | null;
  }>("DELETE FROM inbox_attachments WHERE inbox_item_id = $1 RETURNING blob_id, thumbnail_blob_id, reduced_blob_id", [
    inboxItemId,
  ]);
  // An item with no attachments is the common case, not a failed delete.
  if (result.rowCount === 0) return [];
  return result.rows.flatMap((row) =>
    [row.blob_id, row.thumbnail_blob_id, row.reduced_blob_id].filter((id): id is string => id !== null),
  );
}

/** An attachment the metadata job may still compute the facts of: its blob's location and effective type. */
export interface InboxAttachmentMetadataSource {
  attachmentId: string;
  /** The type the blob has as an attachment (`effectiveBlobMimeTypeSql`). */
  mimeType: string;
  storageKey: string;
  /** Whether `metadata` is already written, which a later run leaves alone. */
  metadataRecorded: boolean;
}

/** The attachment `attachmentId` names, as the metadata job needs it, or null when this tenant has no such row. */
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

/** A derived image whose bytes the caller already wrote to blob storage under `storageKey`. */
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
 * What `recordInboxAttachmentMetadata` did. `recorded: false` means this call wrote nothing: the attachment is gone, its
 * Inbox item is gone, or another run already wrote its metadata. `unusedStorageKeys` are keys of the input's derived images
 * that no `blobs` row this call kept points at (identical bytes already stored under another key), for the caller to
 * remove; when nothing was recorded they are the keys of both images.
 */
export interface RecordedInboxAttachmentMetadata {
  recorded: boolean;
  unusedStorageKeys: string[];
}

/**
 * Writes the facts of one attachment, once, in the caller's transaction (issue gh-1965): `metadata` and the two derived
 * image blobs, and then announces the update of the source Inbox item to its `onItemEvent` heartbeats
 * (`triggerOnItemEventHeartbeats`, event `update`), so a card computed before the facts is computed again with them. The
 * heartbeats are not triggered for an Inbox item in the Trash, which no tick processes. The source item is locked first,
 * as `deleteInboxAttachment` does, and then the row, so `metadata IS NULL` is read under a lock and the update that
 * follows cannot overwrite a concurrent run's. An attachment whose row or item is gone, and one that already has
 * `metadata`, write nothing.
 * The recompute of the Journal day that lists the Inbox item is enqueued in the same transaction (issue gh-1969), so the
 * day's summary shows the page count and the preview without another edit; nothing is enqueued when nothing was recorded.
 * The derived blobs are created with `findOrCreateBlob`: bytes the tenant already stores keep their existing blob, the
 * input's key is then reported unused, and the row names the existing blob.
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

/**
 * Whether an image attachment of the Inbox item is still waiting for its metadata job (`classifyForExtraction`). The
 * Inbox tick does not start for such an item, because its reduced copy does not exist yet; the job announces its write to
 * the item's heartbeats, which starts the tick again.
 */
export async function hasAttachmentAwaitingMetadata(client: Queryable, inboxItemId: string): Promise<boolean> {
  const attachments = await listInboxAttachments(client, [inboxItemId]);
  return attachments.some((attachment) => classifyForExtraction(attachment) === "awaitingMetadata");
}

export interface RecordInboxAttachmentExtractionInput {
  attachmentId: string;
  /** The Inbox item the attachment must belong to; a row of another item is not written. */
  inboxItemId: string;
  extraction: AttachmentExtraction;
}

/**
 * Stores the extraction of one attachment, once, and returns the extraction the row holds afterwards (issue gh-1970).
 * The write is one `UPDATE ... WHERE extraction IS NULL`, so two runs that started together store one value: the loser
 * matches no row and returns the winner's. The row must belong to `inboxItemId` in the tenant in scope. `null` means
 * there is no such row any more (the attachment was deleted while the model was reading it), and nothing is written.
 * Only the API runtime's proposal computation calls it, with an answer of its own gateway call.
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
