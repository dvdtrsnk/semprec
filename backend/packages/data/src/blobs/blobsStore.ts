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
