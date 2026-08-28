import type { Queryable } from "../db/pool.js";
import type { BlobRow } from "../types.js";

function mapBlobRow(row: {
  id: string;
  mime_type: string;
  byte_size: string;
  storage_key: string;
  source_url: string | null;
  content_hash: string | null;
  created_at: Date;
}): BlobRow {
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
  const { rows } = await client.query(
    `INSERT INTO blobs (mime_type, byte_size, storage_key, source_url, content_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${BLOB_COLUMNS}`,
    [input.mimeType, String(input.byteSize), input.storageKey, input.sourceUrl ?? null, input.contentHash ?? null],
  );
  return mapBlobRow(rows[0]);
}

export async function getBlob(client: Queryable, id: string): Promise<BlobRow | null> {
  const { rows } = await client.query(`SELECT ${BLOB_COLUMNS} FROM blobs WHERE id = $1`, [id]);
  return rows[0] ? mapBlobRow(rows[0]) : null;
}

export async function getBlobByContentHash(client: Queryable, contentHash: string): Promise<BlobRow | null> {
  const { rows } = await client.query(`SELECT ${BLOB_COLUMNS} FROM blobs WHERE content_hash = $1`, [contentHash]);
  return rows[0] ? mapBlobRow(rows[0]) : null;
}

/**
 * Content-addressed dedup (issue #26: "the same invoice forwarded three times is stored
 * once") — `createBlob` itself stays a bare insert (issue #24 left dedup enforcement out of
 * its scope on purpose), so this is the one caller-facing entry point that actually dedupes,
 * via the existing partial unique index on `content_hash`. Without `contentHash` there is
 * nothing to dedupe against, so it falls back to a plain insert.
 */
export async function findOrCreateBlob(client: Queryable, input: CreateBlobInput): Promise<BlobRow> {
  if (!input.contentHash) return createBlob(client, input);

  const inserted = await client.query(
    `INSERT INTO blobs (mime_type, byte_size, storage_key, source_url, content_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (content_hash) DO NOTHING
     RETURNING ${BLOB_COLUMNS}`,
    [input.mimeType, String(input.byteSize), input.storageKey, input.sourceUrl ?? null, input.contentHash],
  );
  if (inserted.rows[0]) return mapBlobRow(inserted.rows[0]);

  const existing = await getBlobByContentHash(client, input.contentHash);
  if (!existing) throw new Error(`blob with content_hash '${input.contentHash}' vanished after a no-op conflict`);
  return existing;
}
