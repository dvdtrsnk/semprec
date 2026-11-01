// Owns the choke point's relation edge writes: linking, re-linking (metadata replacement) and
// unlinking two items, the endpoint checks those writes run, and the transaction-scoped
// `*RelationWithClient` functions that internal callers and the approved-operation executor use.
// A domain's own edge-metadata rule (e.g. the Transcripts speaker-edge rule) runs through
// `runRelationEdgeWriteHooks` (./hooks.ts), never a direct import of the domain — relation
// property and relation definition management does not belong here, and neither does any other
// domain module's code.
// Constrained by:
// - docs/adr/2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards.md
// - docs/adr/2026-09-18-exactly-once-execution-of-approved-destructive-operations.md
// - docs/adr/2026-09-12-thin-user-scoped-realtime-invalidations.md
// - docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md
import type { PoolClient } from "pg";
import { requireManagedTransaction, withTransaction } from "../db/pool.js";
import { CardinalityViolationError, NotFoundError, ValidationError } from "../errors.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import * as databasesStore from "./databasesStore.js";
import type { ItemRelationRow } from "../types.js";
import { enqueueRollupRecomputeForEdge } from "../rollup/recompute.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import * as itemsStore from "./itemsStore.js";
import * as relationsStore from "./relationsStore.js";
import {
  assertRelationDatabasesNotArchived,
  assertRelationPropertyWritable,
  assertRelationValueLinkHandoff,
  loadRelationEdgeContext,
  normalizeRelationSides,
  type RelationEdgeContext,
  type SystemRelationWriteContext,
} from "./relationEdgeContext.js";
import { runRelationEdgeDeleteHooks, runRelationEdgeWriteHooks } from "./hooks.js";
import { SYSTEM_WRITER, type WriterIdentity } from "./writerKind.js";

import { breakValueLinksForRelationEdge, VALUE_LINKS_OWNER_PROCESS } from "./valueLinkWrites.js";
import { withValueLinkRelationAdmission } from "./valueLinkRelationAdmission.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** The edge context and the guards every edge write shares: both databases unarchived and the caller's relation property writable by this caller. */
async function loadWritableRelationEdgeContext(
  client: PoolClient,
  relationPropertyId: string,
  context: SystemRelationWriteContext | undefined,
): Promise<RelationEdgeContext> {
  const edgeContext = await loadRelationEdgeContext(client, relationPropertyId);
  await assertRelationDatabasesNotArchived(client, edgeContext);
  assertRelationPropertyWritable(edgeContext.property, context);
  return edgeContext;
}

/** Every check `createRelationWithClient` runs before its write, in the same order, so both raise the same canonical error for the same input. */
async function loadCreatableRelationEdgeContext(
  client: PoolClient,
  input: CreateRelationInput,
  context: SystemRelationWriteContext | undefined,
  mutation = false,
): Promise<RelationEdgeContext> {
  const edgeContext = await loadWritableRelationEdgeContext(client, input.relationPropertyId, context);
  if (mutation && isProtectedRelation(edgeContext, context)) requireManagedTransaction(client);
  await assertRelationValueLinkHandoff(client, edgeContext.property, context, input.callerItemId);
  await assertRelationEndpointsValid(client, edgeContext, input.callerItemId, input.targetItemId);
  return edgeContext;
}

function isProtectedRelation(
  edgeContext: RelationEdgeContext,
  context: SystemRelationWriteContext | undefined,
): boolean {
  return edgeContext.property.owner === "user" && context?.ownerProcess === VALUE_LINKS_OWNER_PROCESS;
}

async function runRelationMutation<T>(
  client: PoolClient,
  edgeContext: RelationEdgeContext,
  context: SystemRelationWriteContext | undefined,
  input: CreateRelationInput,
  insert: boolean,
  hooks: (lockMode?: "nowait") => Promise<void>,
  body: () => Promise<T>,
): Promise<T> {
  if (!isProtectedRelation(edgeContext, context)) {
    await hooks();
    return body();
  }
  const { itemA, itemB } = normalizeRelationSides(
    edgeContext.reldef,
    input.relationPropertyId,
    input.callerItemId,
    input.targetItemId,
  );
  return withValueLinkRelationAdmission(
    client,
    {
      definitionId: edgeContext.reldef.id,
      itemA,
      itemB,
      callerItemId: input.callerItemId,
      propertyKey: edgeContext.property.key,
      insert,
    },
    () => hooks("nowait"),
    body,
  );
}

/** Stands in for the caller of an edge whose item is only proposed and has no id yet; the nil UUID matches no item. */
const PROPOSED_CALLER_ITEM_ID = "00000000-0000-0000-0000-000000000000";

export interface LinkableRelationTargetInput {
  relationPropertyId: string;
  targetItemId: string;
  /** Existing caller, when validating a proposed relation on an existing item. */
  callerItemId?: string;
}

/**
 * Rejects a relation target an edge could not point at. A proposed new item has no caller yet;
 * an existing caller may instead be supplied and its own persisted edge is not a cardinality collision.
 * Target-validation failures carry `details.field` = the relation property key:
 * - the target is missing from the relation's other database (another tenant's item is missing
 *   too), `code: 'targetNotFound'`; soft-deleted, `code: 'targetDeleted'`; a project whose
 *   `status` is `archived`, `code: 'targetArchived'` (a `done` project stays linkable);
 * - `database_archived` / `owner_violation` and edge-metadata hook failures retain the shared edge guards' error details and status;
 * - `CardinalityViolationError` when the target already holds the only edge the relation allows:
 *   any edge for `one_to_one`, any edge on the side of a `one_to_many` whose item may have only one counterpart.
 * The cardinality check only reports; the write at confirm time stays enforced by the database trigger.
 */
export async function assertRelationTargetLinkableWithClient(
  client: PoolClient,
  input: LinkableRelationTargetInput,
  context?: SystemRelationWriteContext,
  writer: WriterIdentity = SYSTEM_WRITER,
): Promise<void> {
  const edgeContext = await loadWritableRelationEdgeContext(client, input.relationPropertyId, context);
  const field = edgeContext.property.key;

  if (input.callerItemId !== undefined) {
    if (!UUID_RE.test(input.callerItemId)) throw new ValidationError("Relation caller must be a UUID", { field });
    await assertRelationEndpointValid(client, edgeContext.property.databaseId, input.callerItemId, "callerItemId");
  }

  if (!UUID_RE.test(input.targetItemId)) {
    throw new ValidationError("Relation target must be a UUID", { field });
  }

  const target = await itemsStore.getItemById(client, edgeContext.targetDatabaseId, input.targetItemId);
  if (!target) {
    throw new ValidationError(
      `Relation target ${input.targetItemId} does not exist in database ${edgeContext.targetDatabaseId}`,
      { field, code: "targetNotFound" },
    );
  }
  if (target.deletedAt) {
    throw new ValidationError(`Relation target ${input.targetItemId} is deleted`, { field, code: "targetDeleted" });
  }
  if (target.properties.status === "archived") {
    const targetDatabase = await databasesStore.getDatabase(client, edgeContext.targetDatabaseId);
    if (targetDatabase?.ownerModuleId === PROJECTS_MODULE_ID) {
      throw new ValidationError(`Relation target ${input.targetItemId} is an archived project`, {
        field,
        code: "targetArchived",
      });
    }
  }

  await runRelationEdgeWriteHooks({
    client,
    edgeContext,
    callerItemId: input.callerItemId ?? PROPOSED_CALLER_ITEM_ID,
    targetItemId: input.targetItemId,
    writer,
  });

  // The proposed item is the (unknown) caller, so the target is item B exactly when the caller's property is side A.
  const targetIsSideB = edgeContext.reldef.propertyIdA === input.relationPropertyId;
  const { cardinality } = edgeContext.reldef;
  if (cardinality === "one_to_one" || (cardinality === "one_to_many" && targetIsSideB)) {
    const edges = await relationsStore.listRelationsForItem(client, edgeContext.reldef.id, input.targetItemId);
    const existing =
      input.callerItemId === undefined
        ? null
        : normalizeRelationSides(edgeContext.reldef, input.relationPropertyId, input.callerItemId, input.targetItemId);
    if (edges.some((edge) => existing === null || edge.itemA !== existing.itemA || edge.itemB !== existing.itemB)) {
      throw new CardinalityViolationError(
        `Relation target ${input.targetItemId} already holds the only edge ${cardinality} relation ${edgeContext.reldef.id} allows`,
        { field, code: "cardinalityViolation", relationDefinitionId: edgeContext.reldef.id, cardinality },
      );
    }
  }
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
  writer: WriterIdentity = SYSTEM_WRITER,
): Promise<void> {
  const edgeContext = await loadCreatableRelationEdgeContext(client, input, context);
  await runRelationEdgeWriteHooks({
    client,
    edgeContext,
    callerItemId: input.callerItemId,
    targetItemId: input.targetItemId,
    metadata: input.metadata,
    writer,
  });
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
  writer: WriterIdentity = SYSTEM_WRITER,
): Promise<RelationEdge> {
  const edgeContext = await loadCreatableRelationEdgeContext(client, input, context, true);
  const hooks = (lockMode?: "nowait") =>
    runRelationEdgeWriteHooks({
      client,
      edgeContext,
      callerItemId: input.callerItemId,
      targetItemId: input.targetItemId,
      metadata: input.metadata,
      writer,
      lockMode,
    });

  const { itemA, itemB } = normalizeRelationSides(
    edgeContext.reldef,
    input.relationPropertyId,
    input.callerItemId,
    input.targetItemId,
  );
  return runRelationMutation(client, edgeContext, context, input, true, hooks, async () => {
    const { edge, inserted } = await relationsStore.createItemRelationReportingInsert(client, {
      relationDefinitionId: edgeContext.reldef.id,
      itemA,
      itemB,
      metadata: input.metadata,
    });
    if (inserted) {
      await breakValueLinksForRelationEdge(client, {
        reldef: edgeContext.reldef,
        itemA,
        itemB,
        writerKind: writer.writerKind,
      });
    }
    await enqueueRollupRecomputeForEdge(client, { relationDefinitionId: edgeContext.reldef.id, itemA, itemB });
    return edge;
  });
}

/** The metadata-replacement counterpart to `createRelationWithClient`: requires an existing normalized edge (endpoints are immutable — moving one is delete plus create), and rejects a missing edge with a `404 not_found`. Same `context` contract as `createRelationWithClient`. */
export async function updateRelationWithClient(
  client: PoolClient,
  input: UpdateRelationInput,
  context?: SystemRelationWriteContext,
  writer: WriterIdentity = SYSTEM_WRITER,
): Promise<RelationEdge> {
  const edgeContext = await loadRelationEdgeContext(client, input.relationPropertyId);
  await assertRelationDatabasesNotArchived(client, edgeContext);
  assertRelationPropertyWritable(edgeContext.property, context);
  if (isProtectedRelation(edgeContext, context)) requireManagedTransaction(client);
  await assertRelationValueLinkHandoff(client, edgeContext.property, context, input.callerItemId);
  await assertRelationEndpointsValid(client, edgeContext, input.callerItemId, input.targetItemId);
  const hooks = (lockMode?: "nowait") =>
    runRelationEdgeWriteHooks({
      client,
      edgeContext,
      callerItemId: input.callerItemId,
      targetItemId: input.targetItemId,
      metadata: input.metadata,
      writer,
      lockMode,
    });

  const { itemA, itemB } = normalizeRelationSides(
    edgeContext.reldef,
    input.relationPropertyId,
    input.callerItemId,
    input.targetItemId,
  );
  return runRelationMutation(client, edgeContext, context, input, false, hooks, async () => {
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
  });
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
  writer: WriterIdentity = SYSTEM_WRITER,
): Promise<RelationEdge | null> {
  const edgeContext = await loadRelationEdgeContext(client, input.relationPropertyId);
  await assertRelationDatabasesNotArchived(client, edgeContext);
  assertRelationPropertyWritable(edgeContext.property, context);
  if (isProtectedRelation(edgeContext, context)) requireManagedTransaction(client);
  await assertRelationValueLinkHandoff(client, edgeContext.property, context, input.callerItemId);
  const { itemA, itemB } = normalizeRelationSides(
    edgeContext.reldef,
    input.relationPropertyId,
    input.callerItemId,
    input.targetItemId,
  );
  // Edge-delete hooks, not the write hooks: those validate metadata and must not run on a removal.
  const hooks = (lockMode?: "nowait") =>
    runRelationEdgeDeleteHooks({
      client,
      edgeContext,
      callerItemId: input.callerItemId,
      targetItemId: input.targetItemId,
      writer,
      lockMode,
    });
  return runRelationMutation(client, edgeContext, context, input, false, hooks, async () => {
    const edge = await relationsStore.deleteItemRelation(client, edgeContext.reldef.id, itemA, itemB);
    if (edge) {
      await breakValueLinksForRelationEdge(client, {
        reldef: edgeContext.reldef,
        itemA,
        itemB,
        writerKind: writer.writerKind,
      });
    }
    await enqueueRollupRecomputeForEdge(client, { relationDefinitionId: edgeContext.reldef.id, itemA, itemB });
    return edge;
  });
}

export function createRelationOps(deps: Pick<ChokePointDeps, "pool">) {
  const { pool } = deps;
  return {
    async createRelation(input: CreateRelationInput, writer?: WriterIdentity): Promise<RelationEdge> {
      return withTransaction(pool, (client) => createRelationWithClient(client, input, undefined, writer));
    },

    async updateRelation(input: UpdateRelationInput, writer?: WriterIdentity): Promise<RelationEdge> {
      return withTransaction(pool, (client) => updateRelationWithClient(client, input, undefined, writer));
    },

    async deleteRelation(input: DeleteRelationInput, writer?: WriterIdentity): Promise<RelationEdge | null> {
      return withTransaction(pool, (client) => deleteRelationWithClient(client, input, undefined, writer));
    },
  };
}
