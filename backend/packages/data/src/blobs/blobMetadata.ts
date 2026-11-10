import type { PoolClient } from "pg";
import { listPropertiesByDatabases } from "../chokePoint/propertiesStore.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<uuid>-<safe filename>`: the last segment of an upload's storage key (see `ingestUploadedFile`). */
const UPLOAD_KEY_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(.+)$/i;

/** What an item envelope reports about the blob a `file`/`image` property points at. */
export interface BlobMetadata {
  blobId: string;
  byteSize: number;
  mimeType: string;
  /** Derived from the storage key; `null` when the key does not follow the upload shape. */
  filename: string | null;
}

/** Per property key. */
export type ItemBlobMetadata = Record<string, BlobMetadata>;

type BlobMetadataDbRow = { id: string; mime_type: string; byte_size: string; storage_key: string };

/** The filename part of a storage key written by `ingestUploadedFile`, or `null` for any other shape. */
export function filenameFromStorageKey(storageKey: string): string | null {
  const segment = storageKey.slice(storageKey.lastIndexOf("/") + 1);
  return UPLOAD_KEY_SEGMENT_RE.exec(segment)?.[1] ?? null;
}

function readBlobId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("blobId" in value)) return undefined;
  const blobId = value.blobId;
  return typeof blobId === "string" && UUID_RE.test(blobId) ? blobId.toLowerCase() : undefined;
}

/**
 * Per item id, the metadata of the blobs its `file`/`image` properties point at, keyed by
 * property key; an item with no visible blob has no entry. Two queries whatever the number of
 * items (property types of the items' databases, then one `blobs` read), under the caller's
 * tenant scope: a blob of another tenant, or one that no longer exists, is left out.
 */
export async function loadBlobMetadataForItems(
  client: PoolClient,
  items: readonly { id: string; databaseId: string; properties: Record<string, unknown> }[],
): Promise<Map<string, ItemBlobMetadata>> {
  const result = new Map<string, ItemBlobMetadata>();
  if (items.length === 0) return result;

  const propertiesByDatabase = await listPropertiesByDatabases(client, [
    ...new Set(items.map((item) => item.databaseId)),
  ]);
  const wanted: { itemId: string; propertyKey: string; blobId: string }[] = [];
  for (const item of items) {
    for (const property of propertiesByDatabase.get(item.databaseId) ?? []) {
      if (property.type !== "file" && property.type !== "image") continue;
      const blobId = readBlobId(item.properties[property.key]);
      if (blobId !== undefined) wanted.push({ itemId: item.id, propertyKey: property.key, blobId });
    }
  }
  if (wanted.length === 0) return result;

  const { rows } = await client.query<BlobMetadataDbRow>(
    "SELECT id, mime_type, byte_size, storage_key FROM blobs WHERE id = ANY($1::uuid[])",
    [[...new Set(wanted.map((entry) => entry.blobId))]],
  );
  const blobs = new Map(rows.map((row) => [row.id, row] as const));
  for (const { itemId, propertyKey, blobId } of wanted) {
    const row = blobs.get(blobId);
    if (!row) continue;
    const forItem = result.get(itemId) ?? {};
    forItem[propertyKey] = {
      blobId: row.id,
      byteSize: Number(row.byte_size),
      mimeType: row.mime_type,
      filename: filenameFromStorageKey(row.storage_key),
    };
    result.set(itemId, forItem);
  }
  return result;
}
