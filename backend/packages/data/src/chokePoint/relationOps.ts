// Owns the choke point's relation edge writes: linking, re-linking (metadata replacement) and
// unlinking two items, the endpoint checks those writes run, and the transaction-scoped
// `*RelationWithClient` functions that internal callers and the approved-operation executor use.
// Successful writes through these functions, including REST, agent and internal callers, run
// changed-edge hooks in the same transaction after rollup work is enqueued.
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
import { z } from "zod";
import { currentTenantScope } from "@semprec/shared";
import {
  markManagedTransactionRollbackOnly,
  requireManagedTransaction,
  runAfterCommitKeyed,
  withTransaction,
} from "../db/pool.js";
import { notifyInvalidation, type InvalidationEvent } from "../realtimeHook.js";
import { CardinalityViolationError, ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import * as databasesStore from "./databasesStore.js";
import type { ItemRelationRow } from "../types.js";
import { enqueueRollupRecomputeForEdge } from "../rollup/recompute.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import * as itemsStore from "./itemsStore.js";
import * as propertiesStore from "./propertiesStore.js";
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
import { runRelationEdgeChangedHooks, runRelationEdgeDeleteHooks, runRelationEdgeWriteHooks } from "./hooks.js";
import { SYSTEM_WRITER, type WriterIdentity } from "./writerKind.js";

import { breakValueLinksForRelationEdge, VALUE_LINKS_OWNER_PROCESS } from "./valueLinkWrites.js";
import { withValueLinkRelationAdmission } from "./valueLinkRelationAdmission.js";
import { assertNotDerivedValueWrite } from "./derivedValueGuard.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The normalized public shape of a stored edge — same fields as `relationsStore.ItemRelationRow`, named here to match the choke-point's own edge contract. */
export type RelationEdge = ItemRelationRow;

export interface CreateRelationInput {
  relationPropertyId: string;
  callerItemId: string;
  targetItemId: string;
  metadata?: Record<string, unknown>;
  actingUserId?: string;
}

export interface UpdateRelationInput {
  relationPropertyId: string;
  callerItemId: string;
  targetItemId: string;
  metadata: Record<string, unknown>;
  actingUserId?: string;
}

const RELATION_INVALIDATION_NAMESPACE = Symbol("relation invalidation");

async function announceRelation(
  client: PoolClient,
  context: RelationEdgeContext,
  input: { relationPropertyId: string; callerItemId: string; targetItemId: string },
  op: "put" | "delete" | "metadata",
  userId?: string,
): Promise<void> {
  const otherId =
    context.reldef.propertyIdA === input.relationPropertyId ? context.reldef.propertyIdB : context.reldef.propertyIdA;
  const other = otherId === null ? null : await propertiesStore.getProperty(client, otherId);
  if (otherId !== null && !other) throw new Error("Relation counterpart property is missing");
  const events: Extract<InvalidationEvent, { scope: "relation" }>[] = [
    {
      scope: "relation",
      databaseId: context.property.databaseId,
      itemId: input.callerItemId,
      propertyKey: context.property.key,
      op,
      userId,
    },
    {
      scope: "relation",
      databaseId: context.targetDatabaseId,
      itemId: input.targetItemId,
      propertyKey: other?.key ?? null,
      op,
      userId,
    },
  ];
  for (const event of events) {
    runAfterCommitKeyed(
      client,
      RELATION_INVALIDATION_NAMESPACE,
      JSON.stringify([event.itemId, event.propertyKey]),
      () => notifyInvalidation(event),
    );
  }
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
  await assertNotDerivedValueWrite(client, {
    edgeContext,
    callerItemId: input.callerItemId,
    targetItemId: input.targetItemId,
    mutation,
  });
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
  actingUserId?: string,
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
        actingUserId: input.actingUserId ?? actingUserId,
      });
    }
    await enqueueRollupRecomputeForEdge(client, { relationDefinitionId: edgeContext.reldef.id, itemA, itemB });
    await runRelationEdgeChangedHooks({
      client,
      op: "create",
      relationDefinitionId: edge.relationDefinitionId,
      propertyId: edgeContext.property.id,
      itemA: edge.itemA,
      itemB: edge.itemB,
      metadata: edge.metadata,
      writer,
    });
    await announceRelation(client, edgeContext, input, "put", input.actingUserId ?? actingUserId);
    return edge;
  });
}

/** Insert an absent edge using the ordinary relation guards, leaving existing metadata intact. */
export async function createRelationIfAbsentWithClient(
  client: PoolClient,
  input: CreateRelationInput,
  context?: SystemRelationWriteContext,
  writer: WriterIdentity = SYSTEM_WRITER,
  actingUserId?: string,
): Promise<{ edge: RelationEdge; inserted: boolean }> {
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
      insertOnly: true,
    });
  const { itemA, itemB } = normalizeRelationSides(
    edgeContext.reldef,
    input.relationPropertyId,
    input.callerItemId,
    input.targetItemId,
  );
  return runRelationMutation(client, edgeContext, context, input, true, hooks, async () => {
    const inserted = await relationsStore.insertItemRelationIfAbsent(client, {
      relationDefinitionId: edgeContext.reldef.id,
      itemA,
      itemB,
      metadata: input.metadata,
    });
    if (!inserted) {
      const existing = await relationsStore.getItemRelationByTuple(client, edgeContext.reldef.id, itemA, itemB);
      if (!existing) throw new ConflictError("Relation changed while confirming", { field: edgeContext.property.key });
      return { edge: existing, inserted: false };
    }
    await breakValueLinksForRelationEdge(client, {
      reldef: edgeContext.reldef,
      itemA,
      itemB,
      writerKind: writer.writerKind,
      actingUserId: input.actingUserId ?? actingUserId,
    });
    await enqueueRollupRecomputeForEdge(client, { relationDefinitionId: edgeContext.reldef.id, itemA, itemB });
    await runRelationEdgeChangedHooks({
      client,
      op: "create",
      relationDefinitionId: inserted.relationDefinitionId,
      propertyId: edgeContext.property.id,
      itemA: inserted.itemA,
      itemB: inserted.itemB,
      metadata: inserted.metadata,
      writer,
    });
    await announceRelation(client, edgeContext, input, "put", input.actingUserId ?? actingUserId);
    return { edge: inserted, inserted: true };
  });
}

/** The metadata-replacement counterpart to `createRelationWithClient`: requires an existing normalized edge (endpoints are immutable — moving one is delete plus create), and rejects a missing edge with a `404 not_found`. Same `context` contract as `createRelationWithClient`. */
export async function updateRelationWithClient(
  client: PoolClient,
  input: UpdateRelationInput,
  context?: SystemRelationWriteContext,
  writer: WriterIdentity = SYSTEM_WRITER,
  actingUserId?: string,
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
    await runRelationEdgeChangedHooks({
      client,
      op: "update",
      relationDefinitionId: edge.relationDefinitionId,
      propertyId: edgeContext.property.id,
      itemA: edge.itemA,
      itemB: edge.itemB,
      metadata: edge.metadata,
      writer,
    });
    await announceRelation(client, edgeContext, input, "metadata", input.actingUserId ?? actingUserId);
    return edge;
  });
}

export type DeleteRelationInput = Omit<CreateRelationInput, "metadata">;

/** Transfer only existing edges from one canonical Threads item to another in the caller's managed transaction. */
export async function transferMailThreadRelationsWithClient(
  client: PoolClient,
  databaseId: string,
  loserId: string,
  winnerId: string,
): Promise<void> {
  requireManagedTransaction(client);
  try {
    const scope = currentTenantScope();
    const state = await client.query<{ isolation: string; tenant: string | null }>(
      "SELECT current_setting('transaction_isolation') AS isolation, app_current_tenant()::text AS tenant",
    );
    if (
      scope?.kind !== "tenant" ||
      state.rows[0]?.isolation !== "read committed" ||
      state.rows[0]?.tenant !== scope.tenantId
    )
      throw new Error("Threads transfer requires a READ COMMITTED tenant transaction");
    const database = await databasesStore.getDatabaseByModuleId(client, THREADS_MODULE_ID);
    if (!database?.system || database.id !== databaseId || loserId === winnerId)
      throw new Error("Invalid Threads merge identity");
    for (const id of [loserId, winnerId].sort()) {
      const item = await itemsStore.lockItemById(client, databaseId, id);
      if (!item || item.deletedAt) throw new NotFoundError("Thread item not found");
    }
    const discovered = await relationsStore.listAllRelationsForItem(client, loserId);
    const definitions = [...new Set(discovered.map((edge) => edge.relationDefinitionId))].sort();
    for (const id of definitions)
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [id]);
    const edges = await relationsStore.lockThreadMergeEdges(client, loserId);
    for (const edge of edges) {
      const definition = await relationsStore.getRelationDefinition(client, edge.relationDefinitionId);
      if (!definition || !definitions.includes(definition.id))
        throw new Error("Thread relation definition changed during merge");
      const context = await loadRelationEdgeContext(client, definition.propertyIdA);
      await assertRelationDatabasesNotArchived(client, context);
      if (context.reldef.id !== definition.id) throw new Error("Thread relation schema mismatch");
      const oldInput = {
        relationPropertyId: definition.propertyIdA,
        callerItemId: edge.itemA,
        targetItemId: edge.itemB,
      };
      const newA = edge.itemA === loserId ? winnerId : edge.itemA;
      const newB = edge.itemB === loserId ? winnerId : edge.itemB;
      const newInput = { relationPropertyId: definition.propertyIdA, callerItemId: newA, targetItemId: newB };
      for (const [id, db] of [
        [edge.itemA, context.property.databaseId],
        [edge.itemB, context.targetDatabaseId],
      ] as const) {
        if (!(await itemsStore.getItemById(client, db, id)))
          throw new NotFoundError("Thread relation endpoint not found");
      }
      const threadProperty =
        context.property.databaseId === databaseId
          ? context.property
          : definition.propertyIdB
            ? await propertiesStore.getProperty(client, definition.propertyIdB)
            : null;
      const winnerEdges = await relationsStore.listRelationsForItem(client, definition.id, winnerId);
      const duplicate = winnerEdges.some((existing) => existing.itemA === newA && existing.itemB === newB);
      const winnerTakesPrecedence =
        threadProperty?.databaseId === databaseId &&
        (threadProperty.key === "project" || threadProperty.key === "company") &&
        winnerEdges.length > 0;
      await runRelationEdgeDeleteHooks({ client, edgeContext: context, ...oldInput, writer: SYSTEM_WRITER });
      const removed = await relationsStore.deleteItemRelation(client, definition.id, edge.itemA, edge.itemB);
      if (!removed || removed.id !== edge.id) throw new Error("Thread relation changed during merge");
      await breakValueLinksForRelationEdge(client, {
        reldef: definition,
        itemA: edge.itemA,
        itemB: edge.itemB,
        writerKind: SYSTEM_WRITER.writerKind,
      });
      await enqueueRollupRecomputeForEdge(client, {
        relationDefinitionId: definition.id,
        itemA: edge.itemA,
        itemB: edge.itemB,
      });
      await runRelationEdgeChangedHooks({
        client,
        op: "delete",
        relationDefinitionId: definition.id,
        propertyId: context.property.id,
        itemA: edge.itemA,
        itemB: edge.itemB,
        metadata: edge.metadata,
        writer: SYSTEM_WRITER,
      });
      await announceRelation(client, context, oldInput, "delete");
      if (duplicate || winnerTakesPrecedence) continue;
      await runRelationEdgeWriteHooks({
        client,
        edgeContext: context,
        ...newInput,
        metadata: edge.metadata,
        writer: SYSTEM_WRITER,
      });
      const inserted = await relationsStore.insertThreadMergeEdgeIfAbsent(client, {
        relationDefinitionId: definition.id,
        itemA: newA,
        itemB: newB,
        metadata: edge.metadata,
      });
      if (!inserted) continue;
      await breakValueLinksForRelationEdge(client, {
        reldef: definition,
        itemA: newA,
        itemB: newB,
        writerKind: SYSTEM_WRITER.writerKind,
      });
      await enqueueRollupRecomputeForEdge(client, { relationDefinitionId: definition.id, itemA: newA, itemB: newB });
      await runRelationEdgeChangedHooks({
        client,
        op: "create",
        relationDefinitionId: definition.id,
        propertyId: context.property.id,
        itemA: newA,
        itemB: newB,
        metadata: inserted.metadata,
        writer: SYSTEM_WRITER,
      });
      await announceRelation(client, context, newInput, "put");
    }
  } catch (error) {
    markManagedTransactionRollbackOnly(client, error);
    throw error;
  }
}

export interface SetRelationInput {
  relationPropertyId: string;
  callerItemId: string;
  targetItemId: string | null;
}

/** Replace the single-valued side of a relation within the caller's transaction. */
export async function setRelationWithClient(
  client: PoolClient,
  input: SetRelationInput,
  writer: WriterIdentity = SYSTEM_WRITER,
  actingUserId?: string,
): Promise<RelationEdge | null> {
  requireManagedTransaction(client);
  input = {
    relationPropertyId: input.relationPropertyId.toLowerCase(),
    callerItemId: input.callerItemId.toLowerCase(),
    targetItemId: input.targetItemId?.toLowerCase() ?? null,
  };
  const edgeContext = await loadWritableRelationEdgeContext(client, input.relationPropertyId, undefined);
  const sideA = edgeContext.reldef.propertyIdA === input.relationPropertyId;
  if (
    edgeContext.reldef.cardinality !== "one_to_one" &&
    !(edgeContext.reldef.cardinality === "one_to_many" && !sideA)
  ) {
    throw new ValidationError("Relation property is not single-valued", { field: "relationPropertyId" });
  }
  const caller = await itemsStore.lockItemById(client, edgeContext.property.databaseId, input.callerItemId);
  if (!caller || caller.deletedAt) {
    throw new ValidationError("Relation caller does not exist or is deleted", { field: "callerItemId" });
  }
  if (input.targetItemId !== null) {
    await assertRelationEndpointValid(client, edgeContext.targetDatabaseId, input.targetItemId, "targetItemId");
  }
  const edges = await relationsStore.listRelationsForItem(client, edgeContext.reldef.id, input.callerItemId);
  const existing = edges.find((edge) => (sideA ? edge.itemA : edge.itemB) === input.callerItemId);
  const oldTarget = existing ? (sideA ? existing.itemB : existing.itemA) : null;
  if (existing && oldTarget !== null && oldTarget === input.targetItemId) {
    await runRelationEdgeWriteHooks({
      client,
      edgeContext,
      callerItemId: input.callerItemId,
      targetItemId: oldTarget,
      metadata: existing.metadata,
      writer,
    });
    return existing;
  }
  if (existing && oldTarget !== null && input.targetItemId !== null) {
    await loadCreatableRelationEdgeContext(client, { ...input, targetItemId: input.targetItemId }, undefined, true);
  }
  if (existing && oldTarget !== null) {
    await deleteRelationWithClient(client, { ...input, targetItemId: oldTarget }, undefined, writer, actingUserId);
  }
  if (input.targetItemId === null) return null;
  return createRelationWithClient(
    client,
    { ...input, targetItemId: input.targetItemId },
    undefined,
    writer,
    actingUserId,
  );
}

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
  actingUserId?: string,
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
        actingUserId: input.actingUserId ?? actingUserId,
      });
      await announceRelation(client, edgeContext, input, "delete", input.actingUserId ?? actingUserId);
    }
    await enqueueRollupRecomputeForEdge(client, { relationDefinitionId: edgeContext.reldef.id, itemA, itemB });
    if (edge)
      await runRelationEdgeChangedHooks({
        client,
        op: "delete",
        relationDefinitionId: edge.relationDefinitionId,
        propertyId: edgeContext.property.id,
        itemA: edge.itemA,
        itemB: edge.itemB,
        metadata: edge.metadata,
        writer,
      });
    return edge;
  });
}

export interface MoveRelationEdgesInput {
  /** The relation property the edges are written through; it governs who may write them. */
  relationPropertyId: string;
  /** The side of `relationPropertyId` that `fromItemId` and `toItemId` are on. */
  side: "caller" | "target";
  fromItemId: string;
  toItemId: string;
}

/** An edge `moveRelationEdgesWithClient` left on `fromItemId`, because the choke point refuses it for `toItemId`. */
export interface RefusedRelationEdge {
  /** The relation property the move was asked for. */
  relationPropertyId: string;
  /** The item at the other end of the edge; it is still linked to `fromItemId`. */
  otherItemId: string;
  /** The `code` of the `ValidationError` that refuses the edge for `toItemId`. */
  code: string;
  /**
   * The `details.field` of that error, or `null` when it names none: `callerItemId` or `targetItemId` for an endpoint
   * that is in the trash or missing, the property key for a value derived from the item's project.
   */
  field: string | null;
}

export interface MoveRelationEdgesResult {
  /** How many edges the call deleted from `fromItemId`. */
  moved: number;
  /** The edges the call left on `fromItemId`; empty when the choke point refused none. */
  refused: RefusedRelationEdge[];
}

const errorDetailsWithField = z.object({ field: z.string() });

/** The `details.field` of a choke-point error, or `null` when its details carry none. */
function errorField(details: unknown): string | null {
  const parsed = errorDetailsWithField.safeParse(details);
  return parsed.success ? parsed.data.field : null;
}

/**
 * The `ValidationError` with which the checks `createRelationWithClient` runs before its write refuse the edge
 * (`assertRelationCreatableWithClient`: authorization, endpoints, derived values, edge metadata), or `null` when they
 * pass. Such an error names an edge that cannot exist as things stand (an endpoint in the trash or missing, a value
 * derived from the item's project, metadata a domain rule refuses). Every other error propagates. Cardinality is not
 * part of the answer: only the write enforces it, so `null` does not promise that the create succeeds.
 */
async function relationCreationRefusal(
  client: PoolClient,
  input: CreateRelationInput,
  context: SystemRelationWriteContext | undefined,
): Promise<ValidationError | null> {
  try {
    await assertRelationCreatableWithClient(client, input, context);
    return null;
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
}

/**
 * Moves the edges of one relation property from `fromItemId` to `toItemId` (issue #1726), each as a delete plus a
 * create through `deleteRelationWithClient` and `createRelationIfAbsentWithClient`, with their guards, hooks and
 * announcements. Three kinds of edge are not moved:
 * - an edge `createRelationWithClient` would refuse for `toItemId` with a `ValidationError`
 *   (`relationCreationRefusal`) stays on `fromItemId` untouched and is returned in `refused`, so the caller decides
 *   what a move that left edges behind means and reports it;
 * - an edge `toItemId` already has keeps its own metadata there, and the one of `fromItemId` is only deleted;
 * - an edge that is no longer stored when its delete runs is not created on `toItemId`.
 * Cardinality is not among them: only the write checks it. When `toItemId` already holds the only edge a `one_to_one`
 * or `one_to_many` relation allows it, the move fails with the `CardinalityViolationError` of the insert, which runs
 * after that edge was deleted from `fromItemId`.
 * Returns how many edges this call deleted from `fromItemId` and the edges it left there. Same `context` contract as
 * `createRelationWithClient`.
 */
export async function moveRelationEdgesWithClient(
  client: PoolClient,
  input: MoveRelationEdgesInput,
  context?: SystemRelationWriteContext,
): Promise<MoveRelationEdgesResult> {
  const { reldef } = await loadRelationEdgeContext(client, input.relationPropertyId);
  const edges = await relationsStore.listRelationsForItem(client, reldef.id, input.fromItemId);
  const edgeOf = (itemId: string, otherItemId: string) => ({
    relationPropertyId: input.relationPropertyId,
    ...(input.side === "caller"
      ? { callerItemId: itemId, targetItemId: otherItemId }
      : { callerItemId: otherItemId, targetItemId: itemId }),
  });

  const result: MoveRelationEdgesResult = { moved: 0, refused: [] };
  for (const edge of edges) {
    const otherItemId = relationsStore.otherSide(edge, input.fromItemId);
    const target = edgeOf(input.toItemId, otherItemId);
    const refusal = await relationCreationRefusal(client, { ...target, metadata: edge.metadata }, context);
    if (refusal) {
      result.refused.push({
        relationPropertyId: input.relationPropertyId,
        otherItemId,
        code: refusal.code,
        field: errorField(refusal.details),
      });
      continue;
    }
    const removed = await deleteRelationWithClient(client, edgeOf(input.fromItemId, otherItemId), context);
    if (!removed) continue;
    result.moved++;
    await createRelationIfAbsentWithClient(client, { ...target, metadata: removed.metadata }, context);
  }
  return result;
}

export function createRelationOps(deps: Pick<ChokePointDeps, "pool">) {
  const { pool } = deps;
  return {
    async setRelation(
      input: SetRelationInput,
      writer?: WriterIdentity,
      actingUserId?: string,
    ): Promise<RelationEdge | null> {
      return withTransaction(pool, (client) => setRelationWithClient(client, input, writer, actingUserId));
    },
    async createRelation(
      input: CreateRelationInput,
      writer?: WriterIdentity,
      actingUserId?: string,
    ): Promise<RelationEdge> {
      return withTransaction(pool, (client) =>
        createRelationWithClient(client, input, undefined, writer, actingUserId),
      );
    },

    async updateRelation(input: UpdateRelationInput, writer?: WriterIdentity): Promise<RelationEdge> {
      return withTransaction(pool, (client) => updateRelationWithClient(client, input, undefined, writer));
    },

    async deleteRelation(
      input: DeleteRelationInput,
      writer?: WriterIdentity,
      actingUserId?: string,
    ): Promise<RelationEdge | null> {
      return withTransaction(pool, (client) =>
        deleteRelationWithClient(client, input, undefined, writer, actingUserId),
      );
    },
  };
}
