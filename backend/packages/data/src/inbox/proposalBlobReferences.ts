import type { PoolClient } from "pg";
import { lockBlobsForReference } from "../blobs/blobsStore.js";
import type { PropertyRow } from "../types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The blob ids the envelope's `file`/`image` properties name; a value that is not `{ blobId: <uuid> }` names none. */
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
 * Holds `FOR KEY SHARE` on every blob the envelope names until the storing transaction ends, so a collection that
 * already chose a blob whose last reference is this card cannot delete it before the card commits. A missing blob is
 * refused later, by the item write at confirm.
 */
export async function lockEnvelopeBlobReferences(
  client: PoolClient,
  properties: Record<string, unknown>,
  propertiesByKey: ReadonlyMap<string, PropertyRow>,
): Promise<void> {
  const ids = blobIdsOfEnvelopeProperties(properties, propertiesByKey);
  if (ids.length > 0) await lockBlobsForReference(client, ids);
}
