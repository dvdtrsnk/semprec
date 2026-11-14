import { isDeepStrictEqual } from "node:util";
import type { PoolClient } from "pg";
import {
  createRelationIfAbsentWithClient,
  createRelationWithClient,
  deleteRelationWithClient,
  type CreateRelationInput,
  type DeleteRelationInput,
  type RelationEdge,
} from "../chokePoint/relationOps.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import type { RemovedRelation, WrittenRelation } from "./proposalHistory.js";

/**
 * What a confirmation wrote to relation edges between items, collected while it writes (issue #1943,
 * `docs/adr/2026-11-14-the-undo-of-a-confirmation-reverses-only-the-edges-it-recorded.md`). The relation write is an upsert, so
 * without this record the undo could not tell an edge the confirmation inserted from one the user had already made, and
 * would delete the user's edge. The confirm stores the record in the history entry of the confirmation.
 */
export interface EdgeRecorder {
  written: WrittenRelation[];
  removed: RemovedRelation[];
}

export function createEdgeRecorder(): EdgeRecorder {
  return { written: [], removed: [] };
}

function endsOf(input: DeleteRelationInput) {
  return {
    relationPropertyId: input.relationPropertyId,
    callerItemId: input.callerItemId,
    targetItemId: input.targetItemId,
  };
}

/**
 * Writes an edge with the replace-the-metadata semantics of `createRelationWithClient` and records what the write did:
 * an edge the write inserted is recorded with `previousMetadata: null`; an edge that already existed is recorded with the
 * metadata it had. The insert is attempted first with `createRelationIfAbsentWithClient`, so that outcome is decided by the
 * statement that wrote the edge, not by a read before it, and it runs the same guards and hooks of an insert.
 */
export async function writeRecordedEdge(
  client: PoolClient,
  recorder: EdgeRecorder,
  input: CreateRelationInput,
  writer: WriterIdentity,
  actingUserId: string | undefined,
): Promise<RelationEdge> {
  const attempt = await createRelationIfAbsentWithClient(client, input, undefined, writer, actingUserId);
  if (attempt.inserted) {
    recorder.written.push({ ...endsOf(input), metadata: attempt.edge.metadata, previousMetadata: null });
    return attempt.edge;
  }
  const edge = await createRelationWithClient(client, input, undefined, writer, actingUserId);
  recorder.written.push({ ...endsOf(input), metadata: edge.metadata, previousMetadata: attempt.edge.metadata });
  return edge;
}

/** Deletes an edge as `deleteRelationWithClient` does and records the metadata of the edge it deleted; nothing is recorded when there was none. */
export async function deleteRecordedEdge(
  client: PoolClient,
  recorder: EdgeRecorder,
  input: DeleteRelationInput,
  writer: WriterIdentity,
  actingUserId: string | undefined,
): Promise<void> {
  const deleted = await deleteRelationWithClient(client, input, undefined, writer, actingUserId);
  if (deleted) recorder.removed.push({ ...endsOf(input), metadata: deleted.metadata });
}

/** The stored edge between `callerItemId` and `targetItemId` through the relation property, or `null`. */
export async function readEdge(client: PoolClient, ends: DeleteRelationInput): Promise<RelationEdge | null> {
  const definition = await relationsStore.getRelationDefinitionByPropertyId(client, ends.relationPropertyId);
  if (!definition) return null;
  const edges = await relationsStore.listRelationsForItem(client, definition.id, ends.callerItemId);
  return edges.find((edge) => relationsStore.otherSide(edge, ends.callerItemId) === ends.targetItemId) ?? null;
}

/** True when the stored edge still holds exactly the metadata the confirmation wrote, so no later edit of the user would be overwritten. */
export function edgeIsAsWritten(edge: RelationEdge, written: WrittenRelation): boolean {
  return isDeepStrictEqual(edge.metadata, written.metadata);
}
