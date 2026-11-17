import type { PoolClient } from "pg";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { ChokePointError, ValidationError } from "../errors.js";
import type { ProposalEnvelope } from "./inboxTickAction.js";
import { requireRelationPropertyId } from "./proposalItemOrigin.js";

/** A `'relation'` envelope's optional edge metadata (already validated as a plain object). */
export function relationEnvelopeMetadata(envelope: ProposalEnvelope): Record<string, unknown> | undefined {
  const { metadata } = envelope.properties;
  if (metadata === undefined) return undefined;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new ValidationError("Relation proposal metadata must be an object", { field: "properties" });
  }
  return { ...metadata };
}

/**
 * Writes the envelope's `relations` edges from the created item, in envelope order, as `writer`. Runs in the confirm
 * transaction, so a failing edge aborts everything; its error is rethrown with `details.field` set to the relation key.
 */
export async function writeEnvelopeRelations(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  relations: ProposalEnvelope["relations"],
  writer: WriterIdentity,
  actingUserId?: string,
): Promise<void> {
  for (const [key, targetItemIds] of Object.entries(relations ?? {})) {
    const relationPropertyId = await requireRelationPropertyId(client, databaseId, key);
    for (const targetItemId of targetItemIds) {
      try {
        await createRelationWithClient(
          client,
          { relationPropertyId, callerItemId: itemId, targetItemId },
          undefined,
          writer,
          actingUserId,
        );
      } catch (error) {
        if (!(error instanceof ChokePointError)) throw error;
        const details = typeof error.details === "object" && error.details !== null ? error.details : {};
        throw new ChokePointError(error.status, error.code, error.message, { ...details, field: key });
      }
    }
  }
}
