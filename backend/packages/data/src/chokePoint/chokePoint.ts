import type { Pool, PoolClient } from "pg";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import * as databasesStore from "./databasesStore.js";
import * as propertiesStore from "./propertiesStore.js";
import * as itemsStore from "./itemsStore.js";
import * as relationsStore from "./relationsStore.js";
import * as viewsStore from "./viewsStore.js";
import { assertRelationDeletable } from "../rollup/mirror.js";
import { createActionQueueAffinity, type ActionQueueAffinity } from "../scheduler/actions.js";
import { createComputedKeyRegistry, type ComputedKeyRegistry } from "./computedKeyRegistry.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "./viewTypeRegistry.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import { mergeOps } from "./mergeOps.js";

// Temporary scaffolding for the choke-point split: the `// ==== block: <file> ====` markers group each
// future module's declarations into one contiguous block. The blocks and markers are removed by #528.

// ==== block: authorization.ts ====
import { assertViewWritable, type Actor } from "./authorization.js";
export type { Actor } from "./authorization.js";

// ==== block: databaseGuards.ts ====

// ==== block: computedKeyRegistry.ts ====

// ==== block: rollup/recompute.ts ====
export { enqueueRollupRecomputeForEdge } from "../rollup/recompute.js";

// ==== block: rollup/config.ts ====

// ==== block: relationEdgeContext.ts ====
import {
  assertRelationDatabasesNotArchived,
  assertRelationPropertyWritable,
  loadRelationEdgeContext,
  normalizeRelationSides,
} from "./relationEdgeContext.js";
export type { SystemRelationWriteContext } from "./relationEdgeContext.js";

// ==== block: databaseOps.ts ====
import { createDatabaseOps } from "./databaseOps.js";
export { databaseArchiveWithClient } from "./databaseOps.js";

// ==== block: itemReads.ts ====
import { createItemReadOps } from "./itemReads.js";
export type { ListItemsInput, CountItemsInput } from "./itemReads.js";

// ==== block: viewQueryOps.ts ====
import { createViewQueryOps } from "./viewQueryOps.js";

// ==== block: viewOps.ts ====
import { createViewOps } from "./viewOps.js";
export { viewDeleteWithClient } from "./viewOps.js";

// ==== block: propertyOps.ts ====
import { createPropertyOps } from "./propertyOps.js";
export { propertyDeleteWithClient } from "./propertyOps.js";

// ==== block: relationPropertyOps.ts ====
import { createRelationPropertyOps } from "./relationPropertyOps.js";
export { createRelationPropertyWithClient } from "./relationPropertyOps.js";
export type { CreateRelationPropertyInput, RelationPropertySideInput } from "./relationPropertyOps.js";

// ==== block: relationOps.ts ====
import { createRelationOps } from "./relationOps.js";
export {
  assertRelationCreatableWithClient,
  createRelationWithClient,
  deleteRelationWithClient,
  updateRelationWithClient,
} from "./relationOps.js";
export type { CreateRelationInput, DeleteRelationInput, RelationEdge, UpdateRelationInput } from "./relationOps.js";

// ==== block: itemWrites.ts ====
import { createItemWriteOps } from "./itemWrites.js";
export { createItemWithClient, updateItemWithClient, writeComputedAndAnnounce } from "./itemWrites.js";
export type {
  CreateItemWithClientOptions,
  CreateItemInput,
  UpdateItemInput,
  UpdateItemWithClientOptions,
} from "./itemWrites.js";

// ==== block: itemTrash.ts ====
import { createItemTrashOps } from "./itemTrash.js";
export { itemDeleteWithClient } from "./itemTrash.js";

// ==== block: destructiveProjection.ts ====
import { createHash } from "node:crypto";
import { canonicalizeJson } from "@semprec/shared";

/** The five approval-gated destructive kinds a `resource_snapshot` can carry (issue #89). */
export type ResourceSnapshotKind =
  "database_archive" | "property_delete" | "view_delete" | "item_delete" | "relation_delete";

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

function buildResourceSnapshot(kind: ResourceSnapshotKind, resourceId: string, projection: unknown): ResourceSnapshot {
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
  | { operation: "relation.delete"; input: { relationPropertyId: string; callerItemId: string; targetItemId: string } };

export async function computeDestructiveResourceProjection(
  client: PoolClient,
  check: DestructiveOperationCheck,
): Promise<DestructiveResourceProjection> {
  switch (check.operation) {
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

// ==== block: chokePoint.ts ====
export function createChokePoint(
  pool: Pool,
  computedKeyRegistry: ComputedKeyRegistry = createComputedKeyRegistry(),
  viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry(),
  queueAffinity: ActionQueueAffinity = createActionQueueAffinity(),
) {
  const deps: ChokePointDeps = { pool, computedKeyRegistry, viewTypeRegistry, queueAffinity };
  return mergeOps(
    createDatabaseOps(deps),
    createPropertyOps(deps),
    createRelationPropertyOps(deps),
    createRelationOps(deps),
    createItemWriteOps(deps),
    createItemReadOps(deps),
    createItemTrashOps(deps),
    createViewOps(deps),
    createViewQueryOps(deps),
  );
}

export type ChokePoint = ReturnType<typeof createChokePoint>;
