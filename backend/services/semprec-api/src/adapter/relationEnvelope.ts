import type { RelationEdge } from "@semprec/data";

/** The wire shape a relation edge write/delete returns (issue #157) — always the full authoritative edge, never an empty 204. */
export interface RelationEnvelope {
  id: string;
  relationDefinitionId: string;
  itemA: string;
  itemB: string;
  metadata: Record<string, unknown>;
}

export function toRelationEnvelope(edge: RelationEdge): RelationEnvelope {
  return {
    id: edge.id,
    relationDefinitionId: edge.relationDefinitionId,
    itemA: edge.itemA,
    itemB: edge.itemB,
    metadata: edge.metadata,
  };
}
