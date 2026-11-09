import { getItemPatchApprovalContribution } from "./hooks.js";
// Owns the single authorize-and-project call for approved destructive operations: the read-only
// projection and `resource_snapshot` hash of the resource each approval-gated destructive kind targets,
// with the exact domain error the matching mutation would throw. `page_restore` is the one kind this
// file does not project: `docs/docPageRestore.ts` does, because `chokePoint/` may not import `docs/`.
// Nothing that performs a write, and no mutation logic of the destructive operations themselves,
// belongs here.
// Constrained by: docs/adr/2026-09-18-exactly-once-execution-of-approved-destructive-operations.md
import { createHash } from "node:crypto";
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

/** The approval-gated destructive kinds a `resource_snapshot` can carry (issue #89; `page_restore` is issue #1617's, computed in `docs/docPageRestore.ts`). */
export type ResourceSnapshotKind =
  | "database_archive"
  | "property_delete"
  | "view_delete"
  | "item_delete"
  | "relation_delete"
  | "page_restore"
  | "item_patch"
  | "relation_put"
  | "relation_set";

/** Persisted alongside every new destructive approval request, and re-derived at execution time to detect a resource that changed since approval was granted. */
export interface ResourceSnapshot {
  kind: ResourceSnapshotKind;
  resourceId: string;
  sha256: string;
}

/** The read-only projection a `ResourceSnapshot` is hashed from, kept alongside it so a conflict result can report the resource's actual current shape. */
export interface DestructiveResourceProjection {
  snapshot: ResourceSnapshot;
  currentResource: unknown;
}

/** Hashes one projection into a `ResourceSnapshot`; exported so a destructive kind computed outside the choke point hashes the same way. */
export function buildResourceSnapshot(
  kind: ResourceSnapshotKind,
  resourceId: string,
  projection: unknown,
): ResourceSnapshot {
  return { kind, resourceId, sha256: createHash("sha256").update(canonicalizeJson(projection), "utf8").digest("hex") };
}

/** Widens a caught `ChokePointError`'s `unknown` `details` back to a spreadable object, so a rethrow can add `currentResource` alongside whatever the original error already carried. */
function detailsObject(details: unknown): Record<string, unknown> {
  return typeof details === "object" && details !== null ? (details as Record<string, unknown>) : {};
}

/** The one authorize-and-project call `DestructiveApprovalPreflight` and `ApprovedOperationExecutor` both make (issue #89) — never mutates, and throws the exact domain error the matching `*WithClient` mutation would throw for the same input, so a rejection here means the mutation would also reject it. */
export type DestructiveOperationCheck =
  | { operation: "database.archive"; input: { databaseId: string } }
  | { operation: "property.delete"; input: { propertyId: string } }
  | { operation: "view.delete"; input: { viewId: string }; actor: Actor }
  | { operation: "item.delete"; input: { itemId: string } }
  | { operation: "item.patch"; input: { itemId: string; properties?: Record<string, unknown>; ifVersion?: string } }
  | { operation: "relation.put"; input: { relationPropertyId: string; callerItemId: string; targetItemId: string } }
  | {
      operation: "relation.set";
      input: { relationPropertyId: string; callerItemId: string; targetItemId: string | null };
    }
  | { operation: "relation.delete"; input: { relationPropertyId: string; callerItemId: string; targetItemId: string } };

export async function computeDestructiveResourceProjection(
  client: PoolClient,
  check: DestructiveOperationCheck,
): Promise<DestructiveResourceProjection> {
  switch (check.operation) {
    case "item.patch": {
      requireManagedTransaction(client);
      const scope = currentTenantScope();
      if (scope?.kind !== "tenant") throw new Error("Item approval requires a tenant scope");
      const transaction = await client.query<{ isolation: string; tenant: string | null }>(
        "SELECT current_setting('transaction_isolation') AS isolation, nullif(current_setting('app.tenant_id', true), '') AS tenant",
      );
      if (transaction.rows[0]?.isolation !== "read committed" || transaction.rows[0]?.tenant !== scope.tenantId)
        throw new Error("Item approval requires a tenant-scoped READ COMMITTED transaction");
      const [visible] = await itemsStore.getItemsByIds(client, [check.input.itemId]);
      if (!visible) throw new NotFoundError(`Item ${check.input.itemId} not found`);
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
      if (!item || item.deletedAt) throw new NotFoundError(`Item ${check.input.itemId} not found`);
      const database = await databasesStore.getDatabase(client, item.databaseId);
      if (!database) throw new NotFoundError(`Database ${item.databaseId} not found`);
      if (database.archivedAt) throw new ForbiddenError("Database is archived", undefined, "database_archived");
      const contribution = database.ownerModuleId && check.input.properties
        ? await getItemPatchApprovalContribution(database.ownerModuleId)?.(client, item, check.input.properties)
        : null;
      if (contribution && check.input.ifVersion !== undefined && check.input.ifVersion !== item.updatedAt) {
        throw new ConflictError("Item was modified since ifVersion was read", { current: item });
      }
      const projected = contribution
        ? { item, databaseArchivedAt: database.archivedAt, command: contribution.snapshot }
        : { item, databaseArchivedAt: database.archivedAt };
      return { snapshot: buildResourceSnapshot("item_patch", item.id, projected), currentResource: { ...projected, approvalDescription: contribution?.description } };
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
      const projected = { caller, target, property: context.property, definition: context.reldef, edges };
      return {
        snapshot: buildResourceSnapshot(
          check.operation === "relation.put" ? "relation_put" : "relation_set",
          caller.id,
          projected,
        ),
        currentResource: projected,
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
      // Loaded before the relation-type checks below (unlike `propertyDeleteWithClient`, which
      // never reads the database at all) purely so a rejection here can report `currentResource` —
      // safe because the real mutation's own check order never depends on this lookup.
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
      // `...IncludingDeleted` (not the live-only lookup) so an already-deleted item can be told
      // apart from one that never existed — both are rejected here as `not_found`. A direct call
      // to `itemDeleteWithClient` treats an already-deleted item as an idempotent no-op, but an
      // *approval request* must not be created against (or later replayed as) deleting a
      // resource that is already gone.
      const [item] = await itemsStore.getItemsByIdsIncludingDeleted(client, [check.input.itemId]);
      if (!item || item.deletedAt) throw new NotFoundError(`Item ${check.input.itemId} not found`);
      const database = await databasesStore.getDatabase(client, item.databaseId);
      if (!database) throw new NotFoundError(`Database ${item.databaseId} not found`);
      const projected = {
        id: item.id,
        databaseId: item.databaseId,
        updatedAt: item.updatedAt,
        deletedAt: item.deletedAt,
        databaseArchivedAt: database.archivedAt,
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
      return { snapshot: buildResourceSnapshot("item_delete", item.id, projected), currentResource: projected };
    }
    case "relation.delete": {
      // Unlike the other four kinds, `currentResource` stays absent from `assertRelationDatabasesNotArchived`/
      // `assertRelationPropertyWritable` failures here: this check order is the exact order
      // `deleteRelationWithClient` itself enforces, and the edge this function would report as
      // `currentResource` isn't loaded until after both of those checks in the real mutation too —
      // loading it earlier just to attach it to a rejection would risk diverging from the
      // mutation's own error precedence, which this function's docstring promises to preserve.
      const edgeContext = await loadRelationEdgeContext(client, check.input.relationPropertyId);
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
      return { snapshot: buildResourceSnapshot("relation_delete", edge.id, projected), currentResource: projected };
    }
  }
}
