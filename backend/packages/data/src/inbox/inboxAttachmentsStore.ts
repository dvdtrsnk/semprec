import type { Queryable } from "../db/pool.js";
import type { PoolClient } from "pg";
import { lockInboxSource, lockInboxSourceIfPresent } from "./inboxSourceGuard.js";

// Owns the `inbox_attachments` table: the files an Inbox item carries (issue #1564). Moving them into
// Files on confirm is issue #1703, and is not done here. Each row names one `blobs` row, and
// `deleteBlobIfUnreferenced` counts these rows, so the bytes of a blob stay while any attachment names it.

/** Where an attachment was taken from; the table's CHECK constraint accepts exactly these values. */
export type InboxAttachmentSource = "camera" | "scan" | "photoLibrary" | "files" | "share";

/** One attachment to append to an Inbox item: the uploaded blob it names and where it came from. */
export interface NewInboxAttachment {
  blobId: string;
  source: InboxAttachmentSource;
}

/** An attachment joined with the blob it names. `byteSize` is a string, as `BlobRow.byteSize` is. */
export interface InboxAttachmentRow {
  attachmentId: string;
  inboxItemId: string;
  blobId: string;
  mimeType: string;
  byteSize: string;
  source: InboxAttachmentSource;
  position: number;
}

interface InboxAttachmentDbRow {
  attachment_id: string;
  inbox_item_id: string;
  blob_id: string;
  mime_type: string;
  byte_size: string;
  source: InboxAttachmentSource;
  position: number;
}

const ATTACHMENT_SELECT = `SELECT a.attachment_id, a.inbox_item_id, a.blob_id, b.mime_type, b.byte_size, a.source, a.position
  FROM inbox_attachments a
  JOIN blobs b ON b.tenant_id = a.tenant_id AND b.id = a.blob_id`;

function mapAttachmentRow(row: InboxAttachmentDbRow): InboxAttachmentRow {
  return {
    attachmentId: row.attachment_id,
    inboxItemId: row.inbox_item_id,
    blobId: row.blob_id,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    source: row.source,
    position: row.position,
  };
}

/**
 * Appends `attachments` to an Inbox item in the order given, after the item's highest position (the
 * first one takes 0). The source lock serializes appenders and the position is read afterward.
 * A blob of another tenant is refused by the composite foreign key to `blobs`.
 */
export async function insertInboxAttachments(
  client: PoolClient,
  inboxItemId: string,
  attachments: NewInboxAttachment[],
): Promise<void> {
  await lockInboxSource(client, inboxItemId);
  await client.query(
    `INSERT INTO inbox_attachments (inbox_item_id, blob_id, position, source)
     SELECT $1::uuid, input.blob_id, (base.next_position + input.ordinal - 1)::integer, input.source
       FROM unnest($2::uuid[], $3::text[]) WITH ORDINALITY AS input(blob_id, source, ordinal)
       CROSS JOIN (
         SELECT COALESCE(MAX(position) + 1, 0) AS next_position
           FROM inbox_attachments WHERE inbox_item_id = $1::uuid
       ) AS base`,
    [
      inboxItemId,
      attachments.map((attachment) => attachment.blobId),
      attachments.map((attachment) => attachment.source),
    ],
  );
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

/**
 * Removes one attachment row and reports whether it existed. The blob it named is left alone: a caller
 * that drops the last reference to a blob releases its bytes through `deleteBlobIfUnreferenced`.
 */
export async function deleteInboxAttachment(client: PoolClient, attachmentId: string): Promise<boolean> {
  const found = await client.query<{ inbox_item_id: string }>(
    "SELECT inbox_item_id FROM inbox_attachments WHERE attachment_id = $1",
    [attachmentId],
  );
  if (!found.rows[0]) return false;
  await lockInboxSource(client, found.rows[0].inbox_item_id, true);
  const result = await client.query("DELETE FROM inbox_attachments WHERE attachment_id = $1", [attachmentId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Removes every attachment row of a permanently deleted Inbox item and returns the blob ids those rows
 * named. `deleteItemDependents` runs it before releasing those blobs, because a row still present would
 * keep its blob referenced.
 */
export async function deleteInboxAttachmentsForItem(client: PoolClient, inboxItemId: string): Promise<string[]> {
  await lockInboxSourceIfPresent(client, inboxItemId, true);
  const { rows } = await client.query<{ blob_id: string }>(
    "DELETE FROM inbox_attachments WHERE inbox_item_id = $1 RETURNING blob_id",
    [inboxItemId],
  );
  return rows.map((row) => row.blob_id);
}
