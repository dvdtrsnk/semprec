import type { ExpandedRelationTarget, Item } from "@semprec/shared";
import type { Pool } from "pg";
import { loadBlobMetadataForItems, withTransaction } from "@semprec/data";
import type { ItemBlobMetadata, ItemRow, ItemValueLinks } from "@semprec/data";

/**
 * The wire shape every successful item read or write returns (issue #238) — always the full
 * authoritative row, never an empty 204. `computed` is read-only from this envelope's point of
 * view (a write attempt to it is rejected upstream with `computed_readonly`). `updatedAt` doubles
 * as the `ifVersion` token a caller passes back on its next write; there is no separate version
 * counter.
 */
export interface ItemEnvelope {
  derived?: Item["derived"];
  automation?: Item["automation"];
  relations?: Record<string, ExpandedRelationTarget[]>;
  relationsTruncated?: string[];
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
  computed: Record<string, unknown>;
  /** Set by the database on insert; additive, so a client that ignores it is unaffected. */
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  fromInbox?: boolean;
  /** Present only when the read asked for `include=links` (issue #1403). */
  links?: ItemValueLinks;
  /**
   * Per property key, the size, type and filename of the blob a `file`/`image` property points at.
   * Omitted when the item has no such property with a blob the caller can see; `properties` is
   * unchanged either way.
   */
  blobs?: ItemBlobMetadata;
}

/** The one place an `ItemRow` (the choke-point's internal row shape) is projected onto the public envelope. */
export function toItemEnvelope(
  item: ItemRow & {
    derived?: Item["derived"];
    automation?: Item["automation"];
    links?: ItemValueLinks;
    relations?: Record<string, ExpandedRelationTarget[]>;
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
    ...(item.fromInbox === undefined ? {} : { fromInbox: item.fromInbox }),
    ...(item.links === undefined ? {} : { links: item.links }),
    ...(item.derived === undefined ? {} : { derived: item.derived }),
    ...(item.automation === undefined ? {} : { automation: item.automation }),
  };
}

/**
 * `toItemEnvelope` for every item of a response, plus the `blobs` field — filled by one lookup for
 * all of them, so a response never issues a blob query per item. Must run inside the caller's
 * tenant scope. The returned envelopes keep the order of `items`.
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

/** Single-item form of `toItemEnvelopes`. */
export async function toItemEnvelopeWithBlobs(
  pool: Pool,
  item: ItemRow & {
    derived?: Item["derived"];
    automation?: Item["automation"];
    links?: ItemValueLinks;
    relations?: Record<string, ExpandedRelationTarget[]>;
    relationsTruncated?: string[];
  },
): Promise<ItemEnvelope> {
  const [envelope] = await toItemEnvelopes(pool, [item]);
  if (envelope === undefined) throw new Error("toItemEnvelopes returned no envelope for one item");
  return envelope;
}

/** `GET /api/items/:id?include=path`'s wire shape (issue #241): the item envelope plus the server-assembled breadcrumb, root-first, ending with the item itself — omitted entirely when `?include=path` wasn't requested. */
export interface ItemDetailEnvelope extends ItemEnvelope {
  path?: ItemEnvelope[];
}

export function toItemDetailEnvelope(item: ItemRow, path?: ItemRow[]): ItemDetailEnvelope {
  return path === undefined ? toItemEnvelope(item) : { ...toItemEnvelope(item), path: path.map(toItemEnvelope) };
}
