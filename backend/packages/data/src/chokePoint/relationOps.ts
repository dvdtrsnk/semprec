// The choke point's relation edge writes: link, re-link (metadata replacement) and unlink, their
// endpoint checks, and the transaction-scoped `*RelationWithClient` functions. Successful writes run
// changed-edge hooks in the same transaction after rollup work is enqueued. Domain edge-metadata
// rules (e.g. Transcripts speakers, see
// docs/adr/2026-09-23-speaker-mappings-are-edges-proposed-on-transcript-cards.md) run through
// `runRelationEdgeWriteHooks`, never a direct domain import.
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
import { THREADS_MODULE_ID } from "../seed/emailModuleKeys.js";
import * as databasesStore from "./databasesStore.js";
import type { ItemRelationRow } from "../types.js";
import { enqueueRollupRecomputeForEdge } from "../rollup/recompute.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import * as itemsStore from "./itemsStore.js";
import * as propertiesStore from "./propertiesStore.js";
import * as relationsStore from "./relationsStore.js";
import { relationTargetBlock } from "./relationTargetState.js";
import {
  assertRelationDatabasesNotArchived,
  assertRelationPropertyWritable,
  assertRelationValueLinkHandoff,
  loadRelationEdgeContext,
  normalizeRelationSides,
  type RelationEdgeContext,
  type SystemRelationWriteContext,
} from "./relationEdgeContext.js";
import {
  runRelationEdgeBeforeLinkBreakHooks,
  runRelationEdgeChangedHooks,
  runRelationEdgeDeleteHooks,
  runRelationEdgeWriteHooks,
} from "./hooks.js";
import { SYSTEM_WRITER, type WriterIdentity } from "./writerKind.js";
import { assertWriterDatabaseAccess } from "../agentGrants/agentDatabaseAccess.js";

import { requireApprovalForInsertedEdgeLinks, requireApprovalForReplacedEdgeLinks } from "./valueLinkApproval.js";
import { breakValueLinksForRelationEdge, VALUE_LINKS_OWNER_PROCESS } from "./valueLinkWrites.js";
import { withValueLinkRelationAdmission } from "./valueLinkRelationAdmission.js";
import { assertNotDerivedValueWrite } from "./derivedValueGuard.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same fields as `relationsStore.ItemRelationRow`, named for the choke point's edge contract. */
export type RelationEdge = ItemRelationRow;

export interface CreateRelationInput {
  relationPropertyId: string;
  callerItemId: string;
  targetItemId: string;
  metadata?: Record<string, unknown>;
  actingUserId?: string;
}

export interface CreateRelationOptions {
  /** Set only by `setRelationWithClient`, which already asked for approval for the whole replacement. */
  linkApprovalDecided?: boolean;
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

/** Rejects a dangling, soft-deleted, or wrong-database endpoint with `validation_failed`; partitioned `items` cannot carry the FK. */
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

/** An edge joins two databases, so an agent's project needs `write` on both. */
async function assertWriterRelationAccess(
  client: PoolClient,
  writer: WriterIdentity,
  edgeContext: RelationEdgeContext,
): Promise<void> {
  await assertWriterDatabaseAccess(client, writer, edgeContext.property.databaseId, "write");
  await assertWriterDatabaseAccess(client, writer, edgeContext.targetDatabaseId, "write");
}

/** Shared edge-write guards: writer access to both databases, both unarchived, and the caller's property writable. */
async function loadWritableRelationEdgeContext(
  client: PoolClient,
  relationPropertyId: string,
  context: SystemRelationWriteContext | undefined,
  writer: WriterIdentity = SYSTEM_WRITER,
): Promise<RelationEdgeContext> {
  const edgeContext = await loadRelationEdgeContext(client, relationPropertyId);
  await assertWriterRelationAccess(client, writer, edgeContext);
  await assertRelationDatabasesNotArchived(client, edgeContext);
  assertRelationPropertyWritable(edgeContext.property, context);
  return edgeContext;
}

/** Every check `createRelationWithClient` runs before its write, in the same order, so both raise the same error. */
async function loadCreatableRelationEdgeContext(
  client: PoolClient,
  input: CreateRelationInput,
  context: SystemRelationWriteContext | undefined,
  mutation = false,
  writer: WriterIdentity = SYSTEM_WRITER,
): Promise<RelationEdgeContext> {
  const edgeContext = await loadWritableRelationEdgeContext(client, input.relationPropertyId, context, writer);
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

/**
 * Right after the edge row was written and before anything locks a value link row (agent approval
 * check, `breakValueLinksForRelationEdge`). A `system` writer never ends a link, so it runs none.
 */
async function runBeforeLinkBreakHooks(
  client: PoolClient,
  op: "create" | "delete",
  edgeContext: RelationEdgeContext,
  edge: RelationEdge,
  writer: WriterIdentity,
): Promise<void> {
  if (writer.writerKind === "system") return;
  await runRelationEdgeBeforeLinkBreakHooks({
    client,
    op,
    relationDefinitionId: edge.relationDefinitionId,
    propertyId: edgeContext.property.id,
    itemA: edge.itemA,
    itemB: edge.itemB,
    metadata: edge.metadata,
    writer,
  });
}

/** The caller of an edge whose item is only proposed; the nil UUID matches no item. */
const PROPOSED_CALLER_ITEM_ID = "00000000-0000-0000-0000-000000000000";

export interface LinkableRelationTargetInput {
  relationPropertyId: string;
  targetItemId: string;
  /** Existing caller, when validating a proposed relation on an existing item. */
  callerItemId?: string;
}

/**
 * Rejects a target an edge could not point at. An existing caller may be supplied; its own edge is
 * then no cardinality collision. Failures carry `details.field` = the relation property key:
 * - missing (another tenant's too) `targetNotFound`; soft-deleted `targetDeleted`; a project with
 *   `status` `archived` `targetArchived` (a `done` project stays linkable);
 * - `database_archived` / `owner_violation` and edge-metadata hook failures keep their details and status;
 * - `CardinalityViolationError` when the target already holds the only edge the relation allows.
 * The cardinality check only reports; the database trigger still enforces it at write time.
 */
export async function assertRelationTargetLinkableWithClient(
  client: PoolClient,
  input: LinkableRelationTargetInput,
  context?: SystemRelationWriteContext,
  writer: WriterIdentity = SYSTEM_WRITER,
): Promise<void> {
  const edgeContext = await loadWritableRelationEdgeContext(client, input.relationPropertyId, context, writer);
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
  // Only an `archived` status needs the owner module.
  const targetOwnerModuleId =
    target.properties.status === "archived"
      ? ((await databasesStore.getDatabase(client, edgeContext.targetDatabaseId))?.ownerModuleId ?? null)
      : null;
  const block = relationTargetBlock(target, targetOwnerModuleId);
  if (block === "targetDeleted") {
    throw new ValidationError(`Relation target ${input.targetItemId} is deleted`, { field, code: block });
  }
  if (block === "targetArchived") {
    throw new ValidationError(`Relation target ${input.targetItemId} is an archived project`, { field, code: block });
  }

  await runRelationEdgeWriteHooks({
    client,
    edgeContext,
    callerItemId: input.callerItemId ?? PROPOSED_CALLER_ITEM_ID,
    targetItemId: input.targetItemId,
    writer,
  });

  // The proposed item is the caller, so the target is item B exactly when the caller's property is side A.
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
 * Rejects what `createRelationWithClient` would reject for authorization or integrity, without
 * writing, so a revised link-existing proposal is refused when made. Cardinality is left to the write.
 */
export async function assertRelationCreatableWithClient(
  client: PoolClient,
  input: CreateRelationInput,
  context?: SystemRelationWriteContext,
  writer: WriterIdentity = SYSTEM_WRITER,
): Promise<void> {
  const edgeContext = await loadCreatableRelationEdgeContext(client, input, context, false, writer);
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
 * Idempotent on the normalized `(relationDefinitionId, itemA, itemB)` tuple: a repeat replaces the
 * whole metadata (never merges, `{}` when omitted), atomically via `ON CONFLICT ... DO UPDATE`.
 * `context` is passed only by protected internal callers, never the public facade.
 */
export async function createRelationWithClient(
  client: PoolClient,
  input: CreateRelationInput,
  context?: SystemRelationWriteContext,
  writer: WriterIdentity = SYSTEM_WRITER,
  actingUserId?: string,
  options: CreateRelationOptions = {},
): Promise<RelationEdge> {
  const edgeContext = await loadCreatableRelationEdgeContext(client, input, context, true, writer);
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
      await runBeforeLinkBreakHooks(client, "create", edgeContext, edge, writer);
      // An agent under a run asks for approval before the edge ends a link; `setRelationWithClient` has
      // decided that already.
      if (!options.linkApprovalDecided) {
        await requireApprovalForInsertedEdgeLinks(client, writer, { reldef: edgeContext.reldef, itemA, itemB });
      }
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

/** Inserts an absent edge with the ordinary guards, leaving existing metadata intact. */
export async function createRelationIfAbsentWithClient(
  client: PoolClient,
  input: CreateRelationInput,
  context?: SystemRelationWriteContext,
  writer: WriterIdentity = SYSTEM_WRITER,
  actingUserId?: string,
): Promise<{ edge: RelationEdge; inserted: boolean }> {
  const edgeContext = await loadCreatableRelationEdgeContext(client, input, context, true, writer);
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
    await runBeforeLinkBreakHooks(client, "create", edgeContext, inserted, writer);
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

/** Replaces an existing edge's metadata; endpoints are immutable (move = delete + create). A missing edge is `404 not_found`. */
export async function updateRelationWithClient(
  client: PoolClient,
  input: UpdateRelationInput,
  context?: SystemRelationWriteContext,
  writer: WriterIdentity = SYSTEM_WRITER,
  actingUserId?: string,
): Promise<RelationEdge> {
  const edgeContext = await loadRelationEdgeContext(client, input.relationPropertyId);
  await assertWriterRelationAccess(client, writer, edgeContext);
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

/**
 * Transfers existing edges between canonical Threads items in the caller's transaction. The winner
 * keeps its own `project`/`company` edge unless the key is in `loserValueWins`.
 */
export async function transferMailThreadRelationsWithClient(
  client: PoolClient,
  databaseId: string,
  loserId: string,
  winnerId: string,
  loserValueWins: ReadonlySet<string> = new Set(),
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
      const valueKey =
        threadProperty?.databaseId === databaseId &&
        (threadProperty.key === "project" || threadProperty.key === "company")
          ? threadProperty.key
          : null;
      const replacesWinner = valueKey !== null && loserValueWins.has(valueKey);
      const winnerTakesPrecedence = valueKey !== null && winnerEdges.length > 0 && !replacesWinner;
      const removeEdge = async (removing: ItemRelationRow): Promise<void> => {
        const removedInput = {
          relationPropertyId: definition.propertyIdA,
          callerItemId: removing.itemA,
          targetItemId: removing.itemB,
        };
        await runRelationEdgeDeleteHooks({ client, edgeContext: context, ...removedInput, writer: SYSTEM_WRITER });
        const removed = await relationsStore.deleteItemRelation(client, definition.id, removing.itemA, removing.itemB);
        if (!removed || removed.id !== removing.id) throw new Error("Thread relation changed during merge");
        await breakValueLinksForRelationEdge(client, {
          reldef: definition,
          itemA: removing.itemA,
          itemB: removing.itemB,
          writerKind: SYSTEM_WRITER.writerKind,
        });
        await enqueueRollupRecomputeForEdge(client, {
          relationDefinitionId: definition.id,
          itemA: removing.itemA,
          itemB: removing.itemB,
        });
        await runRelationEdgeChangedHooks({
          client,
          op: "delete",
          relationDefinitionId: definition.id,
          propertyId: context.property.id,
          itemA: removing.itemA,
          itemB: removing.itemB,
          metadata: removing.metadata,
          writer: SYSTEM_WRITER,
        });
        await announceRelation(client, context, removedInput, "delete");
      };
      await removeEdge(edge);
      if (replacesWinner && !duplicate) {
        const lockedWinnerEdges = await relationsStore.lockThreadMergeEdges(client, winnerId);
        for (const winnerEdge of lockedWinnerEdges.filter((entry) => entry.relationDefinitionId === definition.id))
          await removeEdge(winnerEdge);
      }
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

/** Replaces the single-valued side of a relation within the caller's transaction. */
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
  const edgeContext = await loadWritableRelationEdgeContext(client, input.relationPropertyId, undefined, writer);
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
    await loadCreatableRelationEdgeContext(
      client,
      { ...input, targetItemId: input.targetItemId },
      undefined,
      true,
      writer,
    );
  }
  if (existing && oldTarget !== null) {
    // Replacing or clearing an edge changes a value a link may feed, so an agent under a run asks first.
    // Writing onto an empty relation removes no value.
    const added =
      input.targetItemId === null
        ? null
        : normalizeRelationSides(edgeContext.reldef, input.relationPropertyId, input.callerItemId, input.targetItemId);
    await requireApprovalForReplacedEdgeLinks(client, writer, {
      reldef: edgeContext.reldef,
      removed: [existing],
      added,
    });
    await deleteRelationWithClient(client, { ...input, targetItemId: oldTarget }, undefined, writer, actingUserId);
  }
  if (input.targetItemId === null) return null;
  return createRelationWithClient(
    client,
    { ...input, targetItemId: input.targetItemId },
    undefined,
    writer,
    actingUserId,
    { linkApprovalDecided: true },
  );
}

/**
 * Idempotent whether or not the edge existed. Skips endpoint validation on purpose: cleanup callers
 * (Inbox type deletion, mail reconcilers) routinely delete an edge after an endpoint was soft-deleted,
 * and endpoint validity matters only for creating or moving an edge.
 */
export async function deleteRelationWithClient(
  client: PoolClient,
  input: DeleteRelationInput,
  context?: SystemRelationWriteContext,
  writer: WriterIdentity = SYSTEM_WRITER,
  actingUserId?: string,
): Promise<RelationEdge | null> {
  const edgeContext = await loadRelationEdgeContext(client, input.relationPropertyId);
  await assertWriterRelationAccess(client, writer, edgeContext);
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
  // Edge-delete hooks, not write hooks: those validate metadata and must not run on a removal.
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
      await runBeforeLinkBreakHooks(client, "delete", edgeContext, edge, writer);
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
  /** Governs who may write the edges. */
  relationPropertyId: string;
  /** The side of `relationPropertyId` that `fromItemId` and `toItemId` are on. */
  side: "caller" | "target";
  fromItemId: string;
  toItemId: string;
}

/**
 * An edge left on `fromItemId` because the choke point refuses it for `toItemId`. An edge `toItemId`
 * already holds is never refused: it is deleted from `fromItemId`.
 */
export interface RefusedRelationEdge {
  relationPropertyId: string;
  /** Still linked to `fromItemId`. */
  otherItemId: string;
  code: string;
  /**
   * `null` when the error names none: `callerItemId`/`targetItemId` for a trashed or missing endpoint,
   * the property key for a value derived from the item's project.
   */
  field: string | null;
}

export interface MoveRelationEdgesResult {
  /** Edges deleted from `fromItemId`. */
  moved: number;
  /** Edges left on `fromItemId`. */
  refused: RefusedRelationEdge[];
}

const errorDetailsWithField = z.object({ field: z.string() });

function errorField(details: unknown): string | null {
  const parsed = errorDetailsWithField.safeParse(details);
  return parsed.success ? parsed.data.field : null;
}

/**
 * The `ValidationError` the pre-write checks of `createRelationWithClient` refuse the edge with, or
 * `null`. Every other error propagates. Cardinality is not checked, so `null` does not promise success.
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
 * Moves one property's edges from `fromItemId` to `toItemId`, each as a delete plus
 * `createRelationIfAbsentWithClient`, with their guards, hooks and announcements. Not moved:
 * - an edge `toItemId` already holds keeps its own metadata; the copy is only deleted (counted in
 *   `moved`) and never refused;
 * - an edge `relationCreationRefusal` refuses stays on `fromItemId` and is returned in `refused`;
 * - an edge no longer stored when its delete runs.
 * Cardinality is checked only by the insert, so a full `one_to_one`/`one_to_many` target fails the
 * move with `CardinalityViolationError` after the delete from `fromItemId`.
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
    // No lock: a concurrent delete of the held edge committing in between is indistinguishable from it
    // running after this move.
    const held = normalizeRelationSides(reldef, input.relationPropertyId, target.callerItemId, target.targetItemId);
    if (await relationsStore.getItemRelationByTuple(client, reldef.id, held.itemA, held.itemB)) {
      if (await deleteRelationWithClient(client, edgeOf(input.fromItemId, otherItemId), context)) result.moved++;
      continue;
    }
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
