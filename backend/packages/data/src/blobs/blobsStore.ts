import { visibleDatabaseIds } from "../chokePoint/itemsStore.js";
import type { Queryable } from "../db/pool.js";
import { requireManagedTransaction, requireSingleRow } from "../db/pool.js";
import type { PoolClient } from "pg";
import type { BlobRow } from "../types.js";
import { ValidationError } from "../errors.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";

/**
 * Closed Processing proposals no longer hold blob references (a confirmed card's item does). Must equal
 * `LOCKED_PROPOSAL_STATUSES` in `inbox/inboxTypesStore.ts`; a test keeps them equal.
 */
export const CLOSED_PROPOSAL_STATUSES: readonly string[] = ["confirmed", "rejected"];

type BlobDbRow = {
  id: string;
  mime_type: string;
  byte_size: string;
  storage_key: string;
  source_url: string | null;
  content_hash: string | null;
  created_at: Date;
};

function mapBlobRow(row: BlobDbRow): BlobRow {
  return {
    id: row.id,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    storageKey: row.storage_key,
    sourceUrl: row.source_url,
    contentHash: row.content_hash,
    createdAt: row.created_at.toISOString(),
  };
}

const BLOB_COLUMNS = "id, mime_type, byte_size, storage_key, source_url, content_hash, created_at";

export interface CreateBlobInput {
  mimeType: string;
  byteSize: string | number;
  storageKey: string;
  sourceUrl?: string;
  contentHash?: string;
}

/**
 * Uses `app_tenant_default()`, which also fills `blobs.tenant_id`, so a key's prefix and its row's tenant always agree.
 * Throws without a tenant in scope, before any byte is written.
 */
export async function tenantBlobStorageKey(client: Queryable, key: string): Promise<string> {
  const { rows } = await client.query<{ tenant_id: string | null }>("SELECT app_tenant_default()::text AS tenant_id");
  const tenantId = requireSingleRow(rows, "app_tenant_default() row").tenant_id;
  if (tenantId === null) throw new Error("No tenant is in scope for a blob storage key");
  return `${tenantId}/${key}`;
}

/** Not item state, so written directly rather than through the choke point. Does not dedupe. */
export async function createBlob(client: Queryable, input: CreateBlobInput): Promise<BlobRow> {
  const { rows } = await client.query<BlobDbRow>(
    `INSERT INTO blobs (mime_type, byte_size, storage_key, source_url, content_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${BLOB_COLUMNS}`,
    [input.mimeType, String(input.byteSize), input.storageKey, input.sourceUrl ?? null, input.contentHash ?? null],
  );
  return mapBlobRow(requireSingleRow(rows, "blobs row"));
}

export async function getBlob(client: Queryable, id: string): Promise<BlobRow | null> {
  const { rows } = await client.query<BlobDbRow>(`SELECT ${BLOB_COLUMNS} FROM blobs WHERE id = $1`, [id]);
  return rows[0] ? mapBlobRow(rows[0]) : null;
}

/**
 * Taken before deciding from the blob's Files items whether to create one, so a concurrent filing of the same bytes
 * waits and then sees the first one's item.
 */
export async function lockBlobById(client: Queryable, id: string): Promise<boolean> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM blobs WHERE tenant_id = app_tenant_default() AND id = $1 FOR UPDATE",
    [id],
  );
  return rows.length > 0;
}

/**
 * The detected type wins over the stored `mime_type`, which a dedup hit keeps from its first row (possibly a sender's
 * header). `application/octet-stream` is the detector's "unknown", so it never hides a stored type.
 */
export function effectiveBlobMimeTypeSql(alias: string): string {
  return `COALESCE(NULLIF(${alias}.detected_mime_type, 'application/octet-stream'), ${alias}.mime_type)`;
}

export interface ReferencedBlob {
  id: string;
  mimeType: string;
}

/**
 * `FOR KEY SHARE`, in id order, keeps `deleteBlobIfUnreferenced` (which locks `FOR UPDATE`) from deleting a blob
 * between this read and the insert that references it. Missing or foreign blobs are absent from the result.
 */
export async function lockBlobsForReference(client: Queryable, ids: string[]): Promise<ReferencedBlob[]> {
  const { rows } = await client.query<{ id: string; mime_type: string }>(
    `SELECT b.id, ${effectiveBlobMimeTypeSql("b")} AS mime_type FROM blobs b
      WHERE b.tenant_id = app_tenant_default() AND b.id = ANY($1::uuid[]) ORDER BY b.id FOR KEY SHARE`,
    [ids],
  );
  return rows.map((row) => ({ id: row.id, mimeType: row.mime_type }));
}

/** Reads only content classification previously recorded by the upload owner. */
export async function getDetectedBlobMimeType(client: Queryable, id: string): Promise<string | null> {
  const { rows } = await client.query<{ detected_mime_type: string | null }>(
    "SELECT detected_mime_type FROM blobs WHERE tenant_id = app_tenant_default() AND id = $1",
    [id],
  );
  return rows[0]?.detected_mime_type ?? null;
}

/** Called after the upload owner has locked a visible blob and detected freshly streamed bytes. */
export async function recordDetectedBlobMimeType(client: PoolClient, id: string, mimeType: string): Promise<void> {
  requireManagedTransaction(client);
  const result = await client.query(
    "UPDATE blobs SET detected_mime_type = $2 WHERE tenant_id = app_tenant_default() AND id = $1 AND detected_mime_type IS NULL",
    [id, mimeType],
  );
  if (result.rowCount !== 0 && result.rowCount !== 1) throw new Error("Unexpected blob classification update count");
}

/** RLS confines this to the tenant in scope, so dedupe is per tenant. */
export async function getBlobByContentHash(client: Queryable, contentHash: string): Promise<BlobRow | null> {
  const { rows } = await client.query<BlobDbRow>(`SELECT ${BLOB_COLUMNS} FROM blobs WHERE content_hash = $1`, [
    contentHash,
  ]);
  return rows[0] ? mapBlobRow(rows[0]) : null;
}

/** The one entry point that dedupes by content hash (per tenant); without a hash it is a plain insert. */
export async function findOrCreateBlob(client: Queryable, input: CreateBlobInput): Promise<BlobRow> {
  if (!input.contentHash) return createBlob(client, input);

  const inserted = await client.query<BlobDbRow>(
    // No conflict target: all unique indexes arbitrate, and content deduplication is scoped by
    // blobs_tenant_content_hash_uq.
    `INSERT INTO blobs (mime_type, byte_size, storage_key, source_url, content_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING ${BLOB_COLUMNS}`,
    [input.mimeType, String(input.byteSize), input.storageKey, input.sourceUrl ?? null, input.contentHash],
  );
  if (inserted.rows[0]) return mapBlobRow(inserted.rows[0]);

  const existing = await getBlobByContentHash(client, input.contentHash);
  if (!existing) throw new ValidationError("Invalid blob reference", { field: "blobId" });
  return existing;
}

/**
 * Content-hash dedup shares one blob between uploads, so it is deleted only when nothing references it: no visible
 * item (live or trashed), mail or inbox attachment, speech row, or open Processing proposal envelope. Returns the
 * `storage_key` so the caller removes the bytes after commit; null when still referenced or absent.
 */
export async function deleteBlobIfUnreferenced(client: Queryable, id: string): Promise<string | null> {
  const locked = await client.query<{ id: string }>(
    "SELECT id FROM blobs WHERE tenant_id = app_tenant_default() AND id = $1::uuid FOR UPDATE",
    [id],
  );
  if (locked.rows.length === 0) return null;
  // The `database_id` list prunes partitions. It is read by an earlier statement, so under READ COMMITTED a database
  // committed in between would be missed; the `databases` guard then keeps the blob rather than deleting it from
  // under a reference. A fresh statement after the lock sees references committed while the lock waited.
  const result = await client.query<{ storage_key: string }>(
    `DELETE FROM blobs WHERE tenant_id = app_tenant_default() AND id = $1
       AND NOT EXISTS (SELECT 1 FROM databases WHERE tenant_id = app_tenant_default() AND NOT (id = ANY($3::uuid[])))
       AND NOT EXISTS (
         SELECT 1 FROM items
         WHERE tenant_id = app_tenant_default() AND database_id = ANY($3::uuid[])
           AND lower(properties #>> '{file,blobId}') = lower($2::text)
       )
       AND NOT EXISTS (
         SELECT 1 FROM properties p
         JOIN items i ON i.database_id = p.database_id
         WHERE p.tenant_id = app_tenant_default() AND i.tenant_id = app_tenant_default()
           AND p.type IN ('file', 'image')
           AND p.database_id = ANY($3::uuid[])
           AND i.database_id = ANY($3::uuid[])
           AND lower(i.properties -> p.key ->> 'blobId') = lower($2::text)
       )
       AND NOT EXISTS (SELECT 1 FROM mail_attachments WHERE tenant_id = app_tenant_default() AND blob_id = $1)
       AND NOT EXISTS (
         SELECT 1 FROM inbox_attachments
         WHERE tenant_id = app_tenant_default() AND (blob_id = $1 OR thumbnail_blob_id = $1 OR reduced_blob_id = $1)
       )
       AND NOT EXISTS (SELECT 1 FROM semp_message_speech WHERE tenant_id = app_tenant_default() AND blob_id = $1)
       AND NOT EXISTS (
         SELECT 1 FROM items card
         JOIN databases proposals ON proposals.id = card.database_id
         WHERE card.tenant_id = app_tenant_default() AND proposals.tenant_id = app_tenant_default()
           AND proposals.owner_module_id = $4
           AND card.database_id = ANY($3::uuid[])
           AND coalesce(card.properties ->> 'status', '') <> ALL($5::text[])
           AND strpos(
             lower(coalesce(card.properties -> 'proposal', 'null'::jsonb)::text
               || ' ' || coalesce(card.properties -> 'aiProposal', 'null'::jsonb)::text),
             lower($2::text)
           ) > 0
       )
     RETURNING storage_key`,
    [id, id, await visibleDatabaseIds(client), PROCESSING_PROPOSALS_MODULE_ID, CLOSED_PROPOSAL_STATUSES],
  );
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1) throw new Error("Unexpected unreferenced blob deletion count");
  return requireSingleRow(result.rows, "unreferenced blob deletion").storage_key;
}

/** Standalone uploads (`<tenantId>/blobs/...`). Candidates only; `deleteBlobIfUnreferenced` decides. */
export async function listStandaloneBlobIdsCreatedBefore(
  client: Queryable,
  olderThan: Date,
  afterId: string | null,
  limit: number,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM blobs
     WHERE created_at < $1
       AND split_part(storage_key, '/', 2) = 'blobs'
       AND ($2::uuid IS NULL OR id > $2::uuid)
     ORDER BY id
     LIMIT $3`,
    [olderThan, afterId, limit],
  );
  return rows.map((row) => row.id);
}

/**
 * Unconditional: only for a derived blob owned one-to-one by the item being purged (e.g. a recording's playback
 * audio). A blob dedup may share goes through `deleteBlobIfUnreferenced`.
 */
export async function deleteDerivedBlob(client: Queryable, id: string): Promise<string | null> {
  const { rows } = await client.query<{ storage_key: string }>(
    "DELETE FROM blobs WHERE id = $1 RETURNING storage_key",
    [id],
  );
  return rows[0]?.storage_key ?? null;
}
