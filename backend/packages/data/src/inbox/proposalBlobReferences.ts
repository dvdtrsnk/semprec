import type { PoolClient } from "pg";
import { lockBlobsForReference } from "../blobs/blobsStore.js";
import type { PropertyRow } from "../types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The blob ids a database envelope's `properties` name through the `file` and `image` properties of its target, in
 * the spelling the envelope has them. A value that is not `{ blobId: <uuid> }` names none.
 */
export function blobIdsOfEnvelopeProperties(
  properties: Record<string, unknown>,
  propertiesByKey: ReadonlyMap<string, PropertyRow>,
): string[] {
  const ids = new Set<string>();
  for (const [key, value] of Object.entries(properties)) {
    const type = propertiesByKey.get(key)?.type;
    if ((type !== "file" && type !== "image") || typeof value !== "object" || value === null) continue;
    const id: unknown = Reflect.get(value, "blobId");
    if (typeof id === "string" && UUID_RE.test(id)) ids.add(id.toLowerCase());
  }
  return [...ids];
}

/**
 * Holds `FOR KEY SHARE` on every blob the envelope names until the transaction that stores the envelope ends
 * ([[2026-11-15-an-open-proposal-keeps-the-blobs-its-envelope-names]]). A blob whose last reference is the open card is
 * kept by `deleteBlobIfUnreferenced`; the lock closes the interval before the card commits, in which a collection that
 * already chose the blob would still delete it. A blob that does not exist is not refused here: the write of the item
 * that confirm creates refuses it, as it always did.
 */
export async function lockEnvelopeBlobReferences(
  client: PoolClient,
  properties: Record<string, unknown>,
  propertiesByKey: ReadonlyMap<string, PropertyRow>,
): Promise<void> {
  const ids = blobIdsOfEnvelopeProperties(properties, propertiesByKey);
  if (ids.length > 0) await lockBlobsForReference(client, ids);
}
