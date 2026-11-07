import { visibleDatabaseIds } from "../chokePoint/itemsStore.js";
import type { Queryable } from "../db/pool.js";
import { requireManagedTransaction, requireSingleRow } from "../db/pool.js";
import type { PoolClient } from "pg";
import type { BlobRow } from "../types.js";
import { ValidationError } from "../errors.js";

/** The raw `blobs` row shape this module reads back from Postgres. */
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
 * Prefixes `key` with the tenant in scope, as `<tenantId>/<key>`. The tenant comes from
 * `app_tenant_default()`, the same function that fills `blobs.tenant_id`, so a key's prefix and
 * its row's tenant always agree. Throws when no tenant is in scope, so a caller resolving the key
 * before writing bytes fails before any byte is written.
 */
export async function tenantBlobStorageKey(client: Queryable, key: string): Promise<string> {
  const { rows } = await client.query<{ tenant_id: string | null }>("SELECT app_tenant_default()::text AS tenant_id");
  const tenantId = requireSingleRow(rows, "app_tenant_default() row").tenant_id;
  if (tenantId === null) throw new Error("No tenant is in scope for a blob storage key");
  return `${tenantId}/${key}`;
}

/** `blobs` is not item/database state (no `properties`/`owner`), so it is written directly, the same way `docs`/`doc_snapshots` are — not through the choke-point. */
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
 * Row-locks one blob until the caller's transaction ends, and reports whether it exists. A caller
 * that decides from a read of the blob's Files items whether to create one takes this lock first, so
 * a concurrent transaction filing the same bytes waits and then sees the item the first one created.
 */
export async function lockBlobById(client: Queryable, id: string): Promise<boolean> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM blobs WHERE tenant_id = app_tenant_default() AND id = $1 FOR UPDATE",
    [id],
  );
  return rows.length > 0;
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

/**
 * Looks a blob up by content hash within the tenant in scope: the `tenant_isolation` RLS policy
 * confines the read to that tenant's rows, so identical bytes another tenant stored are invisible
 * here and dedupe is per tenant.
 */
export async function getBlobByContentHash(client: Queryable, contentHash: string): Promise<BlobRow | null> {
  const { rows } = await client.query<BlobDbRow>(`SELECT ${BLOB_COLUMNS} FROM blobs WHERE content_hash = $1`, [
    contentHash,
  ]);
  return rows[0] ? mapBlobRow(rows[0]) : null;
}

/**
 * Content-addressed dedup (issue #26: "the same invoice forwarded three times is stored
 * once") — `createBlob` itself stays a bare insert (issue #24 left dedup enforcement out of
 * its scope on purpose), so this is the one caller-facing entry point that actually dedupes.
 * Dedupe is per tenant: the arbiter is every unique index on `blobs` (the tenant-leading
 * `(tenant_id, content_hash)` index among them), and the read-back after a conflict goes through
 * `getBlobByContentHash`, which RLS confines to the tenant in scope. Without `contentHash` there
 * is nothing to dedupe against, so it falls back to a plain insert.
 */
export async function findOrCreateBlob(client: Queryable, input: CreateBlobInput): Promise<BlobRow> {
  if (!input.contentHash) return createBlob(client, input);

  const inserted = await client.query<BlobDbRow>(
    // No conflict target: all unique indexes arbitrate. Migration 0080 removes the legacy global
    // content-hash index, leaving content deduplication scoped by blobs_tenant_content_hash_uq.
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
 * Deletes blob `id` only when nothing references it any more — no item visible to the caller (live
 * or trashed, in any of its databases, archived ones included) whose `properties.file.blobId` or
 * `properties.<key>.blobId` of any `image` property names it, no mail attachment and no
 * `inbox_attachments` row — because `findOrCreateBlob`'s content-hash dedup shares one blob between
 * identical uploads. Used by the trash purge (issue #675) in its own transaction, after the
 * referencing item is gone. Returns the
 * deleted row's `storage_key` so the caller can remove the bytes after the commit, or null when the
 * blob is still referenced or already absent.
 */
export async function deleteBlobIfUnreferenced(client: Queryable, id: string): Promise<string | null> {
  const locked = await client.query<{ id: string }>(
    "SELECT id FROM blobs WHERE tenant_id = app_tenant_default() AND id = $1::uuid FOR UPDATE",
    [id],
  );
  if (locked.rows.length === 0) return null;
  // The `database_id` bind prunes the reference lookup to the visible partitions; it does not change
  // which rows count as references, since every item in those databases is still considered.
  // The ids are read by an earlier statement, so under READ COMMITTED a database committed in
  // between would be visible to this DELETE but missing from the list, and an item in it that
  // references the blob would go unseen. The `databases` guard makes the DELETE a no-op in that
  // case: the blob is kept, as if still referenced, rather than deleted from under a reference.
  // A fresh statement after the lock sees references committed while lock acquisition waited.
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
       AND NOT EXISTS (SELECT 1 FROM inbox_attachments WHERE tenant_id = app_tenant_default() AND blob_id = $1)
       AND NOT EXISTS (SELECT 1 FROM semp_message_speech WHERE tenant_id = app_tenant_default() AND blob_id = $1)
     RETURNING storage_key`,
    [id, id, await visibleDatabaseIds(client)],
  );
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1) throw new Error("Unexpected unreferenced blob deletion count");
  return requireSingleRow(result.rows, "unreferenced blob deletion").storage_key;
}

/**
 * Ids of the tenant-in-scope's standalone upload blobs (storage key `<tenantId>/blobs/...`, see
 * `ingestUploadedBlob`) created before `olderThan`, in keyset pages ordered by id. Whether a
 * candidate is still referenced is decided by `deleteBlobIfUnreferenced`, not here.
 */
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
 * Deletes blob `id` unconditionally and returns its `storage_key` so the caller can remove the
 * bytes after the commit, or null when the row is absent. Only for a derived blob owned one-to-one
 * by the item being purged (the normalized or playback audio of a recording); a blob that
 * content-hash dedup may share between items goes through `deleteBlobIfUnreferenced` instead.
 */
export async function deleteDerivedBlob(client: Queryable, id: string): Promise<string | null> {
  const { rows } = await client.query<{ storage_key: string }>(
    "DELETE FROM blobs WHERE id = $1 RETURNING storage_key",
    [id],
  );
  return rows[0]?.storage_key ?? null;
}
