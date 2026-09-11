import type { ItemRow } from "@semprec/data";

/**
 * The wire shape every successful item read or write returns (issue #238) — always the full
 * authoritative row, never an empty 204. `computed` is read-only from this envelope's point of
 * view (a write attempt to it is rejected upstream with `computed_readonly`). `updatedAt` doubles
 * as the `ifVersion` token a caller passes back on its next write; there is no separate version
 * counter.
 */
export interface ItemEnvelope {
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
  computed: Record<string, unknown>;
  updatedAt: string;
  deletedAt: string | null;
}

/** The one place an `ItemRow` (the choke-point's internal row shape) is projected onto the public envelope. */
export function toItemEnvelope(item: ItemRow): ItemEnvelope {
  return {
    id: item.id,
    databaseId: item.databaseId,
    properties: item.properties,
    computed: item.computed,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt,
  };
}
