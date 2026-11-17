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
 * The relation edges a confirmation wrote, stored in its history entry. The write is an upsert, so without this record
 * the undo could not tell an inserted edge from one the user already had, and would delete the user's edge.
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
 * Writes an edge like `createRelationWithClient` and records whether it was inserted (`previousMetadata: null`) or
 * already existed (its prior metadata). The insert is attempted first so the outcome is decided by the writing
 * statement, not a prior read.
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

/** Deletes an edge as `deleteRelationWithClient` does and records the deleted edge's metadata, if any. */
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

export async function readEdge(client: PoolClient, ends: DeleteRelationInput): Promise<RelationEdge | null> {
  const definition = await relationsStore.getRelationDefinitionByPropertyId(client, ends.relationPropertyId);
  if (!definition) return null;
  const edges = await relationsStore.listRelationsForItem(client, definition.id, ends.callerItemId);
  return edges.find((edge) => relationsStore.otherSide(edge, ends.callerItemId) === ends.targetItemId) ?? null;
}

/** True when the stored edge still holds exactly the metadata the confirmation wrote. */
export function edgeIsAsWritten(edge: RelationEdge, written: WrittenRelation): boolean {
  return isDeepStrictEqual(edge.metadata, written.metadata);
}
