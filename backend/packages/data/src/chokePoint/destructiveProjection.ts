import {
  getItemDeleteApprovalGuard,
  getItemPatchApprovalContribution,
  readItemDeleteImpact,
  runItemDeletePreLockHooks,
} from "./hooks.js";
// The single authorize-and-project call for approved destructive operations: the read-only projection
// and `resource_snapshot` hash of each approval-gated kind's resource, with the exact domain error the
// matching mutation would throw. `page_restore`, `page_replace`, `page_convert` and `journal_merge` are
// projected in `docs/` and `journal/`, which `chokePoint/` may not import. Nothing here writes.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DatabaseError, type PoolClient } from "pg";
import { canonicalizeJson, currentTenantScope } from "@semprec/shared";
import { ApprovalResourceBusyError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { markManagedTransactionRollbackOnly, requireManagedTransaction } from "../db/pool.js";
import * as databasesStore from "./databasesStore.js";
import * as propertiesStore from "./propertiesStore.js";
import * as itemsStore from "./itemsStore.js";
import * as relationsStore from "./relationsStore.js";
import * as viewsStore from "./viewsStore.js";
import { assertRelationDeletable } from "../rollup/mirror.js";
import { assertViewWritable, type Actor } from "./authorization.js";
import {
  assertRelationDatabasesNotArchived,
  assertRelationPropertyWritable,
  loadRelationEdgeContext,
  normalizeRelationSides,
} from "./relationEdgeContext.js";
import { reserveBreakingLinks, reserveEdgeLinks, type BreakingValueLinks } from "./valueLinkApproval.js";
import { assertWriterDatabaseAccess, readerOfWriter } from "../agentGrants/agentDatabaseAccess.js";
import { assertWriterDeleteCascadeAccess } from "./itemSubtreeAccess.js";

/** The approval-gated destructive kinds a `resource_snapshot` can carry; the `page_*` and `journal_merge` kinds are computed outside the choke point. */
export type ResourceSnapshotKind =
  | "database_archive"
  | "property_delete"
  | "view_delete"
  | "item_delete"
  | "relation_delete"
  | "page_restore"
  | "page_replace"
  | "page_convert"
  | "journal_merge"
  | "item_patch"
  | "relation_put"
  | "relation_set"
  | "link_unlink";

/** Persisted with every destructive approval request and re-derived at execution to detect a resource that changed since approval. */
export interface ResourceSnapshot {
  kind: ResourceSnapshotKind;
  resourceId: string;
  sha256: string;
}

/** Kept alongside the snapshot so a conflict can report the resource's current shape. */
export interface DestructiveResourceProjection {
  snapshot: ResourceSnapshot;
  currentResource: unknown;
  /**
   * The active value links the operation would end; absent when none. Part of `snapshot` for
   * `item.patch`, `relation.put`, `relation.set` and `link.unlink`; reported only for `relation.delete`.
   */
  valueLinks?: BreakingValueLinks;
}

/** Exported so a destructive kind computed outside the choke point hashes the same way. */
export function buildResourceSnapshot(
  kind: ResourceSnapshotKind,
  resourceId: string,
  projection: unknown,
): ResourceSnapshot {
  return { kind, resourceId, sha256: createHash("sha256").update(canonicalizeJson(projection), "utf8").digest("hex") };
}

/** Widens a caught error's `details` so a rethrow can add `currentResource`. */
function detailsObject(details: unknown): Record<string, unknown> {
  return typeof details === "object" && details !== null ? (details as Record<string, unknown>) : {};
}

/** Made by both `DestructiveApprovalPreflight` and `ApprovedOperationExecutor`. Never mutates, and throws the exact error the matching `*WithClient` mutation would, so a rejection here means the mutation would reject too. */
export type DestructiveOperationCheck =
  | { operation: "database.archive"; input: { databaseId: string } }
  | { operation: "property.delete"; input: { propertyId: string } }
  | { operation: "view.delete"; input: { viewId: string }; actor: Actor }
  | {
      operation: "item.delete";
      input: { itemId: string };
      /** Checked for `write` on the item's database and every database its cascade reaches, as `itemDeleteWithClient` does. */
      agentProjectItemId?: string;
    }
  | { operation: "item.patch"; input: { itemId: string; properties?: Record<string, unknown>; ifVersion?: string } }
  | { operation: "relation.put"; input: { relationPropertyId: string; callerItemId: string; targetItemId: string } }
  | {
      operation: "relation.set";
      input: { relationPropertyId: string; callerItemId: string; targetItemId: string | null };
    }
  | {
      operation: "relation.delete";
      input: { relationPropertyId: string; callerItemId: string; targetItemId: string };
      /** Checked for `write` on both endpoint databases, as `deleteRelationWithClient` does. */
      agentProjectItemId?: string;
    }
  | {
      operation: "link.unlink";
      input: { itemId: string; propertyKey: string };
      /** Checked for `write` on the item's database, as `changeValueLinkWithClient` does. */
      agentProjectItemId?: string;
    };

/**
 * Reserves the live item for the rest of the transaction. Requires a tenant-scoped READ COMMITTED
 * transaction; share-locks the database then the item row, both NOWAIT (held = `ApprovalResourceBusyError`).
 * `subject` only words the scope errors.
 */
async function reserveItemForApproval(client: PoolClient, itemId: string, subject: string) {
  requireManagedTransaction(client);
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new Error(`${subject} approval requires a tenant scope`);
  const transaction = await client.query<{ isolation: string; tenant: string | null }>(
    "SELECT current_setting('transaction_isolation') AS isolation, nullif(current_setting('app.tenant_id', true), '') AS tenant",
  );
  if (transaction.rows[0]?.isolation !== "read committed" || transaction.rows[0]?.tenant !== scope.tenantId)
    throw new Error(`${subject} approval requires a tenant-scoped READ COMMITTED transaction`);
  const [visible] = await itemsStore.getItemsByIds(client, [itemId]);
  if (!visible) throw new NotFoundError(`Item ${itemId} not found`);
  let item: Awaited<ReturnType<typeof itemsStore.lockItemByIdNowait>>;
  try {
    await client.query("SELECT id FROM databases WHERE id = $1 FOR SHARE NOWAIT", [visible.databaseId]);
    item = await itemsStore.lockItemByIdNowait(client, visible.databaseId, visible.id);
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "55P03") {
      const busy = new ApprovalResourceBusyError();
      markManagedTransactionRollbackOnly(client, busy);
      throw busy;
    }
    throw error;
  }
  if (!item || item.deletedAt) throw new NotFoundError(`Item ${itemId} not found`);
  return item;
}

/**
 * Locks the item rows at both ends of an edge NOWAIT, in (database id, item id) order like the
 * `relation.put`/`relation.set` check, so a `relation.delete` check holds the endpoints before it
 * share-locks a value link (docs/architecture/agents-approvals-and-ai.md#snapshots-and-reservations).
 * A missing row is skipped (an edge to a purged item can exist). A held row is
 * `ApprovalResourceBusyError` and the transaction can only roll back.
 */
async function lockEdgeEndpointRowsNowait(
  client: PoolClient,
  ends: ReadonlyArray<{ databaseId: string; itemId: string }>,
): Promise<void> {
  try {
    for (const end of [...ends].sort(
      (a, b) => a.databaseId.localeCompare(b.databaseId) || a.itemId.localeCompare(b.itemId),
    )) {
      await itemsStore.lockItemByIdNowait(client, end.databaseId, end.itemId);
    }
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "55P03") {
      const busy = new ApprovalResourceBusyError();
      markManagedTransactionRollbackOnly(client, busy);
      throw busy;
    }
    throw error;
  }
}

export async function computeDestructiveResourceProjection(
  client: PoolClient,
  check: DestructiveOperationCheck,
): Promise<DestructiveResourceProjection> {
  switch (check.operation) {
    case "item.patch": {
      const item = await reserveItemForApproval(client, check.input.itemId, "Item");
      const database = await databasesStore.getDatabase(client, item.databaseId);
      if (!database) throw new NotFoundError(`Database ${item.databaseId} not found`);
      if (database.archivedAt) throw new ForbiddenError("Database is archived", undefined, "database_archived");
      const contribution =
        database.ownerModuleId && check.input.properties
          ? await getItemPatchApprovalContribution(database.ownerModuleId)?.(client, item, check.input.properties)
          : null;
      if (contribution && check.input.ifVersion !== undefined && check.input.ifVersion !== item.updatedAt) {
        throw new ConflictError("Item was modified since ifVersion was read", { current: item });
      }
      // The properties this patch changes are the ones `updateItemWithClient` ends links for.
      const patch = check.input.properties ?? {};
      const changedKeys = Object.keys(patch).filter((key) => !isDeepStrictEqual(item.properties[key], patch[key]));
      const valueLinks = await reserveBreakingLinks(
        client,
        changedKeys.map((propertyKey) => ({ itemId: item.id, propertyKey })),
      );
      const projected = contribution
        ? { item, databaseArchivedAt: database.archivedAt, command: contribution.snapshot }
        : { item, databaseArchivedAt: database.archivedAt };
      if (valueLinks.links.length === 0) {
        return {
          snapshot: buildResourceSnapshot("item_patch", item.id, projected),
          currentResource: { ...projected, approvalDescription: contribution?.description },
        };
      }
      // The request stands while the links and linked values stay as they were.
      const covered = {
        ...(contribution ? projected : { databaseArchivedAt: database.archivedAt }),
        valueLinks: valueLinks.links,
        values: Object.fromEntries(
          valueLinks.links.map((link) => [link.propertyKey, item.properties[link.propertyKey]]),
        ),
      };
      return {
        snapshot: buildResourceSnapshot("item_patch", item.id, covered),
        currentResource: { ...projected, approvalDescription: contribution?.description },
        valueLinks,
      };
    }
    case "relation.put":
    case "relation.set": {
      requireManagedTransaction(client);
      const scope = currentTenantScope();
      if (scope?.kind !== "tenant") throw new Error("Relation approval requires a tenant scope");
      const transaction = await client.query<{ isolation: string; tenant: string | null }>(
        "SELECT current_setting('transaction_isolation') AS isolation, nullif(current_setting('app.tenant_id', true), '') AS tenant",
      );
      if (transaction.rows[0]?.isolation !== "read committed" || transaction.rows[0]?.tenant !== scope.tenantId)
        throw new Error("Relation approval requires a tenant-scoped READ COMMITTED transaction");
      const relationPropertyId = check.input.relationPropertyId.toLowerCase();
      const initial = await loadRelationEdgeContext(client, relationPropertyId);
      await assertRelationDatabasesNotArchived(client, initial);
      assertRelationPropertyWritable(initial.property, undefined);
      const callerId = check.input.callerItemId.toLowerCase();
      const targetId = check.input.targetItemId?.toLowerCase() ?? null;
      const visible = await itemsStore.getItemsByIds(client, [callerId, ...(targetId ? [targetId] : [])]);
      if (!visible.some((item) => item.id === callerId && item.databaseId === initial.property.databaseId))
        throw new NotFoundError("Relation caller not found");
      if (targetId && !visible.some((item) => item.id === targetId && item.databaseId === initial.targetDatabaseId))
        throw new NotFoundError("Relation target not found");
      let context = initial;
      let caller: Awaited<ReturnType<typeof itemsStore.lockItemByIdNowait>>;
      let target: Awaited<ReturnType<typeof itemsStore.lockItemByIdNowait>>;
      let edges: Awaited<ReturnType<typeof relationsStore.lockRelationSnapshotEdgesNowait>>;
      try {
        if (!(await relationsStore.tryLockRelationDefinition(client, initial.reldef.id)))
          throw new ApprovalResourceBusyError();
        await client.query("SELECT id FROM properties WHERE id = $1 FOR SHARE NOWAIT", [initial.property.id]);
        await client.query("SELECT id FROM relation_definitions WHERE id = $1 FOR SHARE NOWAIT", [initial.reldef.id]);
        await client.query("SELECT id FROM databases WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT", [
          [initial.property.databaseId, initial.targetDatabaseId],
        ]);
        context = await loadRelationEdgeContext(client, relationPropertyId);
        if (
          context.reldef.id !== initial.reldef.id ||
          context.property.databaseId !== initial.property.databaseId ||
          context.targetDatabaseId !== initial.targetDatabaseId ||
          context.reldef.propertyIdA !== initial.reldef.propertyIdA ||
          context.reldef.propertyIdB !== initial.reldef.propertyIdB
        )
          throw new Error("Relation context changed during approval reservation");
        await assertRelationDatabasesNotArchived(client, context);
        assertRelationPropertyWritable(context.property, undefined);
        const side = context.reldef.propertyIdA === context.property.id ? "a" : "b";
        const oldEdges = (await relationsStore.listRelationsForItem(client, context.reldef.id, callerId)).filter(
          (edge) => (side === "a" ? edge.itemA : edge.itemB) === callerId,
        );
        const candidates = [
          { id: callerId, databaseId: context.property.databaseId },
          ...(targetId ? [{ id: targetId, databaseId: context.targetDatabaseId }] : []),
          ...(check.operation === "relation.set"
            ? oldEdges.map((edge) => ({
                id: side === "a" ? edge.itemB : edge.itemA,
                databaseId: context.targetDatabaseId,
              }))
            : []),
        ];
        const locked = new Map<string, Awaited<ReturnType<typeof itemsStore.lockItemByIdNowait>>>();
        for (const item of candidates.sort(
          (a, b) => a.databaseId.localeCompare(b.databaseId) || a.id.localeCompare(b.id),
        )) {
          const key = JSON.stringify([item.databaseId, item.id]);
          if (!locked.has(key)) locked.set(key, await itemsStore.lockItemByIdNowait(client, item.databaseId, item.id));
        }
        caller = locked.get(JSON.stringify([context.property.databaseId, callerId])) ?? null;
        target = targetId ? (locked.get(JSON.stringify([context.targetDatabaseId, targetId])) ?? null) : null;
        if (!caller || caller.deletedAt) throw new NotFoundError("Relation caller not found");
        if (targetId && (!target || target.deletedAt)) throw new NotFoundError("Relation target not found");
        edges = await relationsStore.lockRelationSnapshotEdgesNowait(client, context.reldef.id, caller.id, side);
      } catch (error) {
        const failure =
          error instanceof DatabaseError && error.code === "55P03" ? new ApprovalResourceBusyError() : error;
        if (failure instanceof ApprovalResourceBusyError) markManagedTransactionRollbackOnly(client, failure);
        throw failure;
      }
      // The edges this write adds or removes decide which links it ends; a `relation.set` onto an empty
      // relation removes nothing.
      const heldTargets = new Set(edges.map((edge) => relationsStore.otherSide(edge, caller.id)));
      const added =
        targetId && !heldTargets.has(targetId)
          ? normalizeRelationSides(context.reldef, relationPropertyId, caller.id, targetId)
          : null;
      const removed = edges.filter((edge) => relationsStore.otherSide(edge, caller.id) !== targetId);
      const changing =
        check.operation === "relation.put"
          ? added
            ? [added]
            : []
          : removed.length > 0
            ? [...removed, ...(added ? [added] : [])]
            : [];
      const valueLinks = await reserveEdgeLinks(client, context.reldef, changing);
      const projected = { caller, target, property: context.property, definition: context.reldef, edges };
      const covered = valueLinks.links.length > 0 ? { ...projected, valueLinks: valueLinks.links } : projected;
      return {
        snapshot: buildResourceSnapshot(
          check.operation === "relation.put" ? "relation_put" : "relation_set",
          caller.id,
          covered,
        ),
        currentResource: projected,
        ...(valueLinks.links.length > 0 ? { valueLinks } : {}),
      };
    }
    case "database.archive": {
      const database = await databasesStore.getDatabase(client, check.input.databaseId);
      if (!database) throw new NotFoundError(`Database ${check.input.databaseId} not found`);
      if (database.system) {
        throw new ForbiddenError("A system database cannot be archived", { currentResource: database });
      }
      return { snapshot: buildResourceSnapshot("database_archive", database.id, database), currentResource: database };
    }
    case "property.delete": {
      const property = await propertiesStore.getProperty(client, check.input.propertyId);
      if (!property) throw new NotFoundError(`Property ${check.input.propertyId} not found`);
      // Loaded before the relation-type checks only so a rejection can report `currentResource`; the real
      // mutation's check order does not depend on it.
      const database = await databasesStore.getDatabase(client, property.databaseId);
      if (!database) throw new NotFoundError(`Database ${property.databaseId} not found`);
      const projected = {
        ...property,
        databaseSchemaLocked: database.schemaLocked,
        databaseArchivedAt: database.archivedAt,
      };
      if (property.type === "relation") {
        const reldef = await relationsStore.getRelationDefinitionByPropertyId(client, property.id);
        if (reldef) {
          try {
            await assertRelationDeletable(client, reldef.id);
          } catch (err) {
            if (err instanceof ValidationError) {
              throw new ValidationError(err.message, { ...detailsObject(err.details), currentResource: projected });
            }
            throw err;
          }
          const otherPropertyId = reldef.propertyIdA === property.id ? reldef.propertyIdB : reldef.propertyIdA;
          if (otherPropertyId) {
            const otherProperty = await propertiesStore.getProperty(client, otherPropertyId);
            if (otherProperty?.locked) {
              throw new ForbiddenError(`Cannot delete: the paired relation property ${otherPropertyId} is locked`, {
                currentResource: projected,
              });
            }
          }
        }
      }
      return { snapshot: buildResourceSnapshot("property_delete", property.id, projected), currentResource: projected };
    }
    case "view.delete": {
      const view = await viewsStore.getView(client, check.input.viewId);
      if (!view) throw new NotFoundError(`View ${check.input.viewId} not found`);
      try {
        assertViewWritable(view, check.actor);
      } catch (err) {
        if (err instanceof ForbiddenError) {
          throw new ForbiddenError(err.message, { ...detailsObject(err.details), currentResource: view }, err.code);
        }
        throw err;
      }
      return { snapshot: buildResourceSnapshot("view_delete", view.id, view), currentResource: view };
    }
    case "item.delete": {
      // Including deleted items so an already-deleted one is still `not_found` here: a direct
      // `itemDeleteWithClient` treats it as a no-op, but an approval must not be created for (or replayed
      // as) deleting a resource that is already gone.
      const [unlocked] = await itemsStore.getItemsByIdsIncludingDeleted(client, [check.input.itemId]);
      if (!unlocked || unlocked.deletedAt) throw new NotFoundError(`Item ${check.input.itemId} not found`);
      await assertWriterDatabaseAccess(client, check, unlocked.databaseId, "write", unlocked.id);
      await assertWriterDeleteCascadeAccess(client, check, unlocked);
      const database = await databasesStore.getDatabase(client, unlocked.databaseId);
      if (!database) throw new NotFoundError(`Database ${unlocked.databaseId} not found`);
      // The owning module's locks come first, as in `itemDeleteWithClient`, and are held through the
      // approved delete in this transaction, so the item and impact read below are what the delete finds.
      if (database.ownerModuleId !== null) {
        await runItemDeletePreLockHooks(database.ownerModuleId, { client, database, itemId: unlocked.id });
      }
      const [item] = await itemsStore.getItemsByIdsIncludingDeleted(client, [unlocked.id]);
      if (!item || item.deletedAt) throw new NotFoundError(`Item ${check.input.itemId} not found`);
      // The module's delete impact is part of the snapshot: an approval is not executed once its counts
      // changed. The counts are those the writer's reader may see, as in the preview.
      const impact = await readItemDeleteImpact({ client, database, item, reader: readerOfWriter(check) });
      const projected = {
        id: item.id,
        databaseId: item.databaseId,
        updatedAt: item.updatedAt,
        deletedAt: item.deletedAt,
        databaseArchivedAt: database.archivedAt,
        ...(impact === null ? {} : { impact }),
      };
      if (database.archivedAt) {
        throw new ForbiddenError(
          `Database ${item.databaseId} is archived and cannot be written to`,
          { field: "databaseId", currentResource: projected },
          "database_archived",
        );
      }
      if (item.properties.systemActive === true) {
        throw new ForbiddenError(`Item ${item.id} is a system-active project and cannot be deleted, only deactivated`, {
          field: "systemActive",
          currentResource: projected,
        });
      }
      // The cascade's delete hooks run after the soft delete and cannot run here. The module's guard states
      // the refusal one of them would answer an agent with; it comes last, as the hooks do.
      const guard = database.ownerModuleId ? getItemDeleteApprovalGuard(database.ownerModuleId) : undefined;
      const refusal = guard ? await guard({ client, database, item }) : null;
      if (refusal !== null) throw new ForbiddenError(refusal, { currentResource: projected });
      return { snapshot: buildResourceSnapshot("item_delete", item.id, projected), currentResource: projected };
    }
    case "relation.delete": {
      // `currentResource` stays absent from these failures: this is `deleteRelationWithClient`'s exact
      // check order, and loading the edge earlier could diverge from its error precedence.
      const edgeContext = await loadRelationEdgeContext(client, check.input.relationPropertyId);
      await assertWriterDatabaseAccess(client, check, edgeContext.property.databaseId, "write");
      await assertWriterDatabaseAccess(client, check, edgeContext.targetDatabaseId, "write");
      await assertRelationDatabasesNotArchived(client, edgeContext);
      assertRelationPropertyWritable(edgeContext.property, undefined);
      const { itemA, itemB } = normalizeRelationSides(
        edgeContext.reldef,
        check.input.relationPropertyId,
        check.input.callerItemId,
        check.input.targetItemId,
      );
      const edge = await relationsStore.getItemRelationByTuple(client, edgeContext.reldef.id, itemA, itemB);
      if (!edge) {
        throw new NotFoundError(`Relation edge not found`, {
          resource: "relationEdge",
          relationPropertyId: check.input.relationPropertyId,
          callerItemId: check.input.callerItemId,
          targetItemId: check.input.targetItemId,
        });
      }
      const property = edgeContext.property;
      const projected = {
        ...edge,
        property: {
          id: property.id,
          owner: property.owner,
          ownerProcess: property.ownerProcess,
          locked: property.locked,
        },
      };
      // Endpoint rows before links, as in the `relation.put`/`relation.set` check: the following write waits
      // on the rule's target row, and a held link lock before that wait could close a cycle.
      await lockEdgeEndpointRowsNowait(client, [
        { databaseId: edgeContext.property.databaseId, itemId: check.input.callerItemId.toLowerCase() },
        { databaseId: edgeContext.targetDatabaseId, itemId: check.input.targetItemId.toLowerCase() },
      ]);
      const valueLinks = await reserveEdgeLinks(client, edgeContext.reldef, [{ itemA, itemB }]);
      return {
        snapshot: buildResourceSnapshot("relation_delete", edge.id, projected),
        currentResource: projected,
        ...(valueLinks.links.length > 0 ? { valueLinks } : {}),
      };
    }
    case "link.unlink": {
      const item = await reserveItemForApproval(client, check.input.itemId, "Item");
      await assertWriterDatabaseAccess(client, check, item.databaseId, "write", item.id);
      const valueLinks = await reserveBreakingLinks(client, [
        { itemId: item.id, propertyKey: check.input.propertyKey },
      ]);
      if (valueLinks.links.length === 0) {
        throw new ConflictError("The value link is no longer active", { current: item });
      }
      return {
        snapshot: buildResourceSnapshot("link_unlink", item.id, { valueLinks: valueLinks.links }),
        currentResource: { item, valueLinks: valueLinks.links },
        valueLinks,
      };
    }
  }
}
