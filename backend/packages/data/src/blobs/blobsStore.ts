import type { Queryable } from "../db/pool.js";
import { requireSingleRow } from "../db/pool.js";
import type { BlobRow } from "../types.js";

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

export async function getBlobByContentHash(client: Queryable, contentHash: string): Promise<BlobRow | null> {
  const { rows } = await client.query<BlobDbRow>(`SELECT ${BLOB_COLUMNS} FROM blobs WHERE content_hash = $1`, [
    contentHash,
  ]);
  return rows[0] ? mapBlobRow(rows[0]) : null;
}

/**
 * Content-addressed dedup (issue #26: "the same invoice forwarded three times is stored
 * once") — `createBlob` itself stays a bare insert (issue #24 left dedup enforcement out of
 * its scope on purpose), so this is the one caller-facing entry point that actually dedupes,
 * via the partial unique indexes on `content_hash`. Without `contentHash` there is
 * nothing to dedupe against, so it falls back to a plain insert.
 */
export async function findOrCreateBlob(client: Queryable, input: CreateBlobInput): Promise<BlobRow> {
  if (!input.contentHash) return createBlob(client, input);

  const inserted = await client.query<BlobDbRow>(
    // No conflict target on purpose: `content_hash` is now guarded by both the legacy global
    // partial index and its tenant-leading successor (0064), and a targeted ON CONFLICT only
    // arbitrates the named index — a concurrent identical insert would trip the other one with
    // a unique_violation instead of being skipped. A bare DO NOTHING covers every unique index.
    `INSERT INTO blobs (mime_type, byte_size, storage_key, source_url, content_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING ${BLOB_COLUMNS}`,
    [input.mimeType, String(input.byteSize), input.storageKey, input.sourceUrl ?? null, input.contentHash],
  );
  if (inserted.rows[0]) return mapBlobRow(inserted.rows[0]);

  const existing = await getBlobByContentHash(client, input.contentHash);
  if (!existing) throw new Error(`blob with content_hash '${input.contentHash}' vanished after a no-op conflict`);
  return existing;
}

/**
 * Deletes blob `id` only when nothing references it any more — no item in any partition (live or
 * trashed) whose `properties.file.blobId` names it and no mail attachment — because
 * `findOrCreateBlob`'s content-hash dedup shares one blob between identical uploads. Used by the
 * trash purge (issue #675) in its own transaction, after the referencing item is gone. Returns the
 * deleted row's `storage_key` so the caller can remove the bytes after the commit, or null when the
 * blob is still referenced or already absent.
 */
export async function deleteBlobIfUnreferenced(client: Queryable, id: string): Promise<string | null> {
  // `@>` rather than `->> =` so the lookup can use `items_props_gin` (jsonb_path_ops).
  const { rows } = await client.query<{ storage_key: string }>(
    `DELETE FROM blobs WHERE id = $1
       AND NOT EXISTS (
         SELECT 1 FROM items WHERE properties @> jsonb_build_object('file', jsonb_build_object('blobId', $2::text))
       )
       AND NOT EXISTS (SELECT 1 FROM mail_attachments WHERE blob_id = $1)
     RETURNING storage_key`,
    [id, id],
  );
  return rows[0]?.storage_key ?? null;
}
