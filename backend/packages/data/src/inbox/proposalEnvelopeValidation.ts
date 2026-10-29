import type { PoolClient } from "pg";
import type { PropertyRow } from "../types.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import { ValidationError } from "../errors.js";
import { assertRelationTargetLinkableWithClient } from "../chokePoint/relationOps.js";

/** Checks a `'database'` envelope's `relations`: each key a relation property of the target database, unique target ids, every target linkable. */
export async function assertValidEnvelopeRelations(
  client: PoolClient,
  targetDatabaseId: string,
  propertiesByKey: ReadonlyMap<string, PropertyRow>,
  relations: NonNullable<ProposalEnvelope["relations"]>,
): Promise<void> {
  for (const [key, targetItemIds] of Object.entries(relations)) {
    const property = propertiesByKey.get(key);
    if (!property || property.type !== "relation") {
      throw new ValidationError(
        `Proposal relations reference '${key}', which is not a relation property of target database ${targetDatabaseId}`,
        { field: key },
      );
    }
    if (new Set(targetItemIds).size !== targetItemIds.length) {
      throw new ValidationError(`Proposal relations for '${key}' list the same target more than once`, { field: key });
    }
    for (const targetItemId of targetItemIds) {
      await assertRelationTargetLinkableWithClient(client, { relationPropertyId: property.id, targetItemId });
    }
  }
}

/** Checks that every key of `properties` is a writable, user-owned, non-relation, non-rollup property of the database. */
export function assertWritableProposalPropertyKeys(
  properties: Record<string, unknown>,
  propertiesByKey: ReadonlyMap<string, PropertyRow>,
  databaseId: string,
): void {
  for (const key of Object.keys(properties)) {
    const property = propertiesByKey.get(key);
    if (!property) {
      throw new ValidationError(
        `Proposal properties reference unknown property '${key}' on target database ${databaseId}`,
        { field: key },
      );
    }
    if (property.type === "relation") {
      throw new ValidationError(`Proposal properties cannot set relation property '${key}' directly`, { field: key });
    }
    if (property.type === "rollup") {
      throw new ValidationError(`Proposal properties cannot set read-only rollup property '${key}'`, { field: key });
    }
    if (property.owner === "system") {
      throw new ValidationError(`Proposal properties cannot set system-owned property '${key}'`, { field: key });
    }
  }
}
