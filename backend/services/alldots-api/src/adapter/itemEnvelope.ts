import type { Item, ItemRelationTarget } from "@alldots/shared";
import type { Pool } from "pg";
import { loadBlobMetadataForItems, withTransaction } from "@alldots/data";
import type { ItemBlobMetadata, ItemRow, ItemValueLinks } from "@alldots/data";

/** Always the full authoritative row, never an empty 204. `version` is the `ifVersion` token. */
export interface ItemEnvelope {
  derived?: Item["derived"];
  automation?: Item["automation"];
  relations?: Record<string, ItemRelationTarget[]>;
  relationsTruncated?: string[];
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
  computed: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: string;
  fromInbox?: boolean;
  /** Present only when the read asked for `include=links`. */
  links?: ItemValueLinks;
  /**
   * Per property key, the size, type and filename of the blob a `file`/`image` property points at.
   * Omitted when the item has no blob the caller can see.
   */
  blobs?: ItemBlobMetadata;
}

export function toItemEnvelope(
  item: ItemRow & {
    derived?: Item["derived"];
    automation?: Item["automation"];
    links?: ItemValueLinks;
    relations?: Record<string, ItemRelationTarget[]>;
    relationsTruncated?: string[];
  },
): ItemEnvelope {
  return {
    ...(item.relations === undefined
      ? {}
      : { relations: item.relations, relationsTruncated: item.relationsTruncated ?? [] }),
    id: item.id,
    databaseId: item.databaseId,
    properties: item.properties,
    computed: item.computed,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt,
    version: item.version,
    ...(item.fromInbox === undefined ? {} : { fromInbox: item.fromInbox }),
    ...(item.links === undefined ? {} : { links: item.links }),
    ...(item.derived === undefined ? {} : { derived: item.derived }),
    ...(item.automation === undefined ? {} : { automation: item.automation }),
  };
}

/**
 * One blob lookup for all items, never one per item. Must run inside the caller's tenant scope;
 * keeps the order of `items`.
 */
export async function toItemEnvelopes(
  pool: Pool,
  items: readonly (ItemRow & { links?: ItemValueLinks; derived?: Item["derived"]; automation?: Item["automation"] })[],
): Promise<ItemEnvelope[]> {
  const envelopes = items.map(toItemEnvelope);
  const metadata = await withTransaction(pool, (client) => loadBlobMetadataForItems(client, envelopes));
  return envelopes.map((envelope) => {
    const blobs = metadata.get(envelope.id);
    return blobs === undefined ? envelope : { ...envelope, blobs };
  });
}

export async function toItemEnvelopeWithBlobs(
  pool: Pool,
  item: ItemRow & {
    derived?: Item["derived"];
    automation?: Item["automation"];
    links?: ItemValueLinks;
    relations?: Record<string, ItemRelationTarget[]>;
    relationsTruncated?: string[];
  },
): Promise<ItemEnvelope> {
  const [envelope] = await toItemEnvelopes(pool, [item]);
  if (envelope === undefined) throw new Error("toItemEnvelopes returned no envelope for one item");
  return envelope;
}

/** The breadcrumb is root-first and ends with the item itself. */
export interface ItemDetailEnvelope extends ItemEnvelope {
  path?: ItemEnvelope[];
}

export function toItemDetailEnvelope(item: ItemRow, path?: ItemRow[]): ItemDetailEnvelope {
  return path === undefined ? toItemEnvelope(item) : { ...toItemEnvelope(item), path: path.map(toItemEnvelope) };
}
