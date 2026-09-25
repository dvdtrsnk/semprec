// Owns the choke point's relation edge writes: linking, re-linking (metadata replacement) and
// unlinking two items, the endpoint and edge-metadata checks those writes run (including the
// Transcripts speaker-edge rule), and the transaction-scoped `*RelationWithClient` functions that
// internal callers and the approved-operation executor use. Relation property and relation
// definition management does not belong here, and neither does any other domain module's code.
// Constrained by:
// - docs/adr/2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards.md
// - docs/adr/2026-09-18-exactly-once-execution-of-approved-destructive-operations.md
// - docs/adr/2026-09-12-thin-user-scoped-realtime-invalidations.md
import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import type { ItemRelationRow } from "../types.js";
import { enqueueRollupRecomputeForEdge } from "../rollup/recompute.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import * as itemsStore from "./itemsStore.js";
import * as relationsStore from "./relationsStore.js";
import {
  assertRelationDatabasesNotArchived,
  assertRelationPropertyWritable,
  loadRelationEdgeContext,
  normalizeRelationSides,
  type RelationEdgeContext,
  type SystemRelationWriteContext,
} from "./relationEdgeContext.js";
import { assertSpeakerEdgeWritable, isTranscriptSpeakersProperty } from "../transcription/transcriptionSpeakerEdges.js";

/** The normalized public shape of a stored edge — same fields as `relationsStore.ItemRelationRow`, named here to match the choke-point's own edge contract. */
export type RelationEdge = ItemRelationRow;

export interface CreateRelationInput {
  relationPropertyId: string;
  callerItemId: string;
  targetItemId: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateRelationInput {
  relationPropertyId: string;
  callerItemId: string;
  targetItemId: string;
  metadata: Record<string, unknown>;
}

/** Rejects a dangling, soft-deleted, or wrong-database endpoint with `validation_failed` — PostgreSQL foreign keys cannot enforce this because `items` has a partitioned composite primary key. */
async function assertRelationEndpointValid(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  field: "callerItemId" | "targetItemId",
): Promise<void> {
  const item = await itemsStore.getItemById(client, databaseId, itemId);
  if (!item || item.deletedAt) {
    throw new ValidationError(
      `Relation endpoint ${itemId} does not exist, is deleted, or is not in database ${databaseId}`,
      { field },
    );
  }
}

async function assertRelationEndpointsValid(
  client: PoolClient,
  context: RelationEdgeContext,
  callerItemId: string,
  targetItemId: string,
): Promise<void> {
  await assertRelationEndpointValid(client, context.property.databaseId, callerItemId, "callerItemId");
  await assertRelationEndpointValid(client, context.targetDatabaseId, targetItemId, "targetItemId");
}

/** Every check `createRelationWithClient` runs before its write, in the same order, so both raise the same canonical error for the same input. */
async function loadCreatableRelationEdgeContext(
  client: PoolClient,
  input: DeleteRelationInput,
  context: SystemRelationWriteContext | undefined,
): Promise<RelationEdgeContext> {
  const edgeContext = await loadRelationEdgeContext(client, input.relationPropertyId);
  await assertRelationDatabasesNotArchived(client, edgeContext);
  assertRelationPropertyWritable(edgeContext.property, context);
  await assertRelationEndpointsValid(client, edgeContext, input.callerItemId, input.targetItemId);
  return edgeContext;
}

/**
 * Rejects edge metadata its relation gives a required shape to — today only the Transcripts
 * `speakers` relation (issue #185), whose edges each map one speaker key of the transcript to one
 * person. Runs on both add and metadata replace, so neither can leave a mapping the render path
 * cannot read; removing an edge needs no metadata and is not checked here.
 */
async function assertRelationEdgeMetadataValid(
  client: PoolClient,
  edgeContext: RelationEdgeContext,
  input: CreateRelationInput,
): Promise<void> {
  if (!(await isTranscriptSpeakersProperty(client, edgeContext.property))) return;
  await assertSpeakerEdgeWritable(client, {
    relationDefinitionId: edgeContext.reldef.id,
    transcriptsDatabaseId: edgeContext.property.databaseId,
    transcriptId: input.callerItemId,
    personId: input.targetItemId,
    metadata: input.metadata,
  });
}

/**
 * Rejects an edge `createRelationWithClient` would reject for authorization or integrity —
 * `database_archived`, `owner_violation`, `validation_failed` (including its edge-metadata rules,
 * issue #185) — without writing it (issue #184: a revised link-existing proposal is refused when
 * it is made, not only when it is confirmed). Cardinality is not checked here: that is enforced by
 * the write itself, at confirm time.
 */
export async function assertRelationCreatableWithClient(
  client: PoolClient,
  input: CreateRelationInput,
  context?: SystemRelationWriteContext,
): Promise<void> {
  const edgeContext = await loadCreatableRelationEdgeContext(client, input, context);
  await assertRelationEdgeMetadataValid(client, edgeContext, input);
}

/**
 * The relation-linking logic, factored out for the same reason as `createItemWithClient` above.
 * Idempotent on the normalized `(relationDefinitionId, itemA, itemB)` tuple: a repeat create
 * replaces the entire metadata object (never merges), including back to `{}` when the caller
 * omits it — `relationsStore.createItemRelation`'s `ON CONFLICT ... DO UPDATE` is what makes
 * this atomic against a concurrent create of the same edge. `context` is never supplied by the
 * public facade (see `createChokePoint`'s `createRelation` below) — only a protected internal
 * caller passes one.
 */
export async function createRelationWithClient(
  client: PoolClient,
  input: CreateRelationInput,
  context?: SystemRelationWriteContext,
): Promise<RelationEdge> {
  const edgeContext = await loadCreatableRelationEdgeContext(client, input, context);
  await assertRelationEdgeMetadataValid(client, edgeContext, input);

  const { itemA, itemB } = normalizeRelationSides(
    edgeContext.reldef,
    input.relationPropertyId,
    input.callerItemId,
    input.targetItemId,
  );
  const edge = await relationsStore.createItemRelation(client, {
    relationDefinitionId: edgeContext.reldef.id,
    itemA,
    itemB,
    metadata: input.metadata,
  });
  await enqueueRollupRecomputeForEdge(client, { relationDefinitionId: edgeContext.reldef.id, itemA, itemB });
  return edge;
}

/** The metadata-replacement counterpart to `createRelationWithClient`: requires an existing normalized edge (endpoints are immutable — moving one is delete plus create), and rejects a missing edge with a `404 not_found`. Same `context` contract as `createRelationWithClient`. */
export async function updateRelationWithClient(
  client: PoolClient,
  input: UpdateRelationInput,
  context?: SystemRelationWriteContext,
): Promise<RelationEdge> {
  const edgeContext = await loadRelationEdgeContext(client, input.relationPropertyId);
  await assertRelationDatabasesNotArchived(client, edgeContext);
  assertRelationPropertyWritable(edgeContext.property, context);
  await assertRelationEndpointsValid(client, edgeContext, input.callerItemId, input.targetItemId);
  await assertRelationEdgeMetadataValid(client, edgeContext, input);

  const { itemA, itemB } = normalizeRelationSides(
    edgeContext.reldef,
    input.relationPropertyId,
    input.callerItemId,
    input.targetItemId,
  );
  const edge = await relationsStore.updateItemRelationMetadata(
    client,
    edgeContext.reldef.id,
    itemA,
    itemB,
    input.metadata,
  );
  if (!edge) {
    throw new NotFoundError(`Relation edge not found`, {
      resource: "relationEdge",
      relationPropertyId: input.relationPropertyId,
      callerItemId: input.callerItemId,
      targetItemId: input.targetItemId,
    });
  }
  await enqueueRollupRecomputeForEdge(client, { relationDefinitionId: edgeContext.reldef.id, itemA, itemB });
  return edge;
}

export type DeleteRelationInput = Omit<CreateRelationInput, "metadata">;

/**
 * The relation-unlinking counterpart to `createRelationWithClient` above, factored out for the
 * same reason (issue #26: the IMAP adapter's VANISHED/UID-diff handling removes a
 * folder-membership edge inside its own larger sync transaction). Idempotent: returns
 * regardless of whether the edge existed — deliberately skips `assertRelationEndpointsValid`
 * (unlike create/update), because a real cleanup caller routinely deletes an edge *after* one
 * of its endpoints was soft-deleted (`inboxTypesStore`'s `deleteInboxTypeWithClient`, and the
 * Gmail/Graph/IMAP reconcilers dropping folder edges for an already-removed message) — endpoint
 * validity only matters for creating or moving an edge, never for tearing one down. The
 * normalized `(relationDefinitionId, itemA, itemB)` lookup in `deleteItemRelation` is safe
 * regardless of endpoint state. Same `context` contract as `createRelationWithClient`.
 */
export async function deleteRelationWithClient(
  client: PoolClient,
  input: DeleteRelationInput,
  context?: SystemRelationWriteContext,
): Promise<RelationEdge | null> {
  const edgeContext = await loadRelationEdgeContext(client, input.relationPropertyId);
  await assertRelationDatabasesNotArchived(client, edgeContext);
  assertRelationPropertyWritable(edgeContext.property, context);
  const { itemA, itemB } = normalizeRelationSides(
    edgeContext.reldef,
    input.relationPropertyId,
    input.callerItemId,
    input.targetItemId,
  );
  const edge = await relationsStore.deleteItemRelation(client, edgeContext.reldef.id, itemA, itemB);
  await enqueueRollupRecomputeForEdge(client, { relationDefinitionId: edgeContext.reldef.id, itemA, itemB });
  return edge;
}

export function createRelationOps(deps: Pick<ChokePointDeps, "pool">) {
  const { pool } = deps;
  return {
    async createRelation(input: CreateRelationInput): Promise<RelationEdge> {
      return withTransaction(pool, (client) => createRelationWithClient(client, input));
    },

    async updateRelation(input: UpdateRelationInput): Promise<RelationEdge> {
      return withTransaction(pool, (client) => updateRelationWithClient(client, input));
    },

    async deleteRelation(input: DeleteRelationInput): Promise<RelationEdge | null> {
      return withTransaction(pool, (client) => deleteRelationWithClient(client, input));
    },
  };
}
