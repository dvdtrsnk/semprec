import type { Pool, PoolClient } from "pg";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import type { ItemRow, PropertyRow, PropertyType } from "../types.js";
import * as databasesStore from "./databasesStore.js";
import * as propertiesStore from "./propertiesStore.js";
import * as itemsStore from "./itemsStore.js";
import * as relationsStore from "./relationsStore.js";
import * as viewsStore from "./viewsStore.js";
import { enqueueRollupBackfill } from "../rollup/recompute.js";
import { assertRelationDeletable, assertSourceRetypeAllowed } from "../rollup/mirror.js";
import { triggerOnItemEventHeartbeats } from "../scheduler/schedulerStore.js";
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
import { assertDatabaseNotArchived } from "./databaseGuards.js";

// ==== block: computedKeyRegistry.ts ====
import { assertNoComputedKeyCollision } from "./computedKeyRegistry.js";

// ==== block: rollup/recompute.ts ====
import { enqueueRollupRecomputeForEdge } from "../rollup/recompute.js";
export { enqueueRollupRecomputeForEdge } from "../rollup/recompute.js";

// ==== block: rollup/config.ts ====
import { applyRollupConfig } from "../rollup/config.js";

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
import { enqueuePropertyTypeMigration, isConversionSupported } from "../migrationJob/propertyTypeMigration.js";

/**
 * Transaction-scoped counterpart to `chokePoint.deleteProperty` (issue #89), factored out so
 * `ApprovedOperationExecutor` can run it against the same locked transaction as its own
 * revalidation instead of `chokePoint.deleteProperty` opening a second, independent one.
 */
export async function propertyDeleteWithClient(
  client: PoolClient,
  id: string,
  actingUserId?: string,
): Promise<PropertyRow> {
  const property = await propertiesStore.getProperty(client, id);
  if (!property) throw new NotFoundError(`Property ${id} not found`);

  const invalidatedDatabaseIds = new Set([property.databaseId]);
  if (property.type === "relation") {
    const reldef = await relationsStore.getRelationDefinitionByPropertyId(client, id);
    if (reldef) {
      await assertRelationDeletable(client, reldef.id);
      const otherPropertyId = reldef.propertyIdA === id ? reldef.propertyIdB : reldef.propertyIdA;
      if (otherPropertyId) {
        const otherProperty = await propertiesStore.getProperty(client, otherPropertyId);
        if (otherProperty?.locked) {
          throw new ForbiddenError(`Cannot delete: the paired relation property ${otherPropertyId} is locked`);
        }
        if (otherProperty) invalidatedDatabaseIds.add(otherProperty.databaseId);
        await propertiesStore.deleteProperty(client, otherPropertyId);
      }
    }
  }
  await propertiesStore.deleteProperty(client, id);
  runAfterCommit(client, () => {
    for (const databaseId of invalidatedDatabaseIds)
      notifyInvalidation({ scope: "schema", databaseId, userId: actingUserId });
  });
  return property;
}

/**
 * The config-update logic shared by `chokePoint.updatePropertyConfig` and `chokePoint.updateProperty`
 * (issue #240), factored out so `updateProperty` can run it against the same client/transaction as
 * a sibling rename/type-change instead of opening its own.
 */
async function updatePropertyConfigWithClient(
  client: PoolClient,
  id: string,
  config: Record<string, unknown>,
): Promise<PropertyRow> {
  const property = await propertiesStore.updatePropertyConfig(client, id, config);
  if (property.type === "rollup") {
    await applyRollupConfig(client, property);
    await enqueueRollupBackfill(client, property.id);
  }
  return property;
}

/**
 * The type-change logic shared by `chokePoint.changePropertyType` and `chokePoint.updateProperty`
 * (issue #240), factored out for the same reason as `updatePropertyConfigWithClient` above.
 */
async function changePropertyTypeWithClient(
  client: PoolClient,
  id: string,
  newType: PropertyType,
): Promise<PropertyRow> {
  const property = await propertiesStore.getProperty(client, id);
  if (!property) throw new ValidationError(`Property ${id} not found`);
  const oldType = property.type;
  if (oldType === newType) return property;

  if ([oldType, newType].includes("relation") || [oldType, newType].includes("rollup")) {
    throw new ValidationError("Retyping into or out of 'relation'/'rollup' is not supported via changePropertyType", {
      field: "type",
    });
  }
  await assertSourceRetypeAllowed(client, property.databaseId, property.key, newType);
  if (!isConversionSupported(oldType, newType)) {
    throw new ValidationError(`No conversion path from '${oldType}' to '${newType}'; create a new property instead`, {
      field: "type",
    });
  }

  const updated = await propertiesStore.changePropertyType(client, id, newType, "pending");
  await enqueuePropertyTypeMigration(client, id, oldType);
  return updated;
}

function createPropertyOps(deps: Pick<ChokePointDeps, "pool" | "computedKeyRegistry">) {
  const { pool, computedKeyRegistry } = deps;
  return {
    async listProperties(databaseId: string): Promise<PropertyRow[]> {
      return withTransaction(pool, (client) => propertiesStore.listPropertiesByDatabase(client, databaseId));
    },
    async getProperty(id: string): Promise<PropertyRow | null> {
      return withTransaction(pool, (client) => propertiesStore.getProperty(client, id));
    },

    /** Resolves a relation route's `:propertyKey` path segment (issue #157) — the choke-point's edge calls take a property id, never a key, so a REST caller must go through this first. */
    async getPropertyByKey(databaseId: string, key: string): Promise<PropertyRow | null> {
      return withTransaction(pool, (client) => propertiesStore.getPropertyByKey(client, databaseId, key));
    },

    /** Backs the `property.getByKey` generic operation (issue #432) — see `propertiesStore.findPropertiesByKey`. */
    async findPropertiesByKey(databaseId: string, key: string, type?: PropertyType): Promise<PropertyRow[]> {
      return withTransaction(pool, (client) => propertiesStore.findPropertiesByKey(client, databaseId, key, type));
    },

    async createProperty(input: propertiesStore.CreatePropertyInput, actingUserId?: string): Promise<PropertyRow> {
      assertNoComputedKeyCollision(computedKeyRegistry, input.key);
      if (input.type === "rollup") {
        return withTransaction(pool, async (client) => {
          const property = await propertiesStore.createProperty(client, input);
          await applyRollupConfig(client, property);
          await enqueueRollupBackfill(client, property.id);
          const finalProperty = (await propertiesStore.getProperty(client, property.id)) as PropertyRow;
          runAfterCommit(client, () =>
            notifyInvalidation({ scope: "schema", databaseId: finalProperty.databaseId, userId: actingUserId }),
          );
          return finalProperty;
        });
      }
      return withTransaction(pool, async (client) => {
        const property = await propertiesStore.createProperty(client, input);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: property.databaseId, userId: actingUserId }),
        );
        return property;
      });
    },

    async renameProperty(id: string, name: string, actingUserId?: string): Promise<PropertyRow> {
      return withTransaction(pool, async (client) => {
        const property = await propertiesStore.renameProperty(client, id, name);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: property.databaseId, userId: actingUserId }),
        );
        return property;
      });
    },

    async updatePropertyConfig(
      id: string,
      config: Record<string, unknown>,
      actingUserId?: string,
    ): Promise<PropertyRow> {
      return withTransaction(pool, async (client) => {
        const property = await updatePropertyConfigWithClient(client, id, config);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: property.databaseId, userId: actingUserId }),
        );
        return property;
      });
    },

    async changePropertyType(id: string, newType: PropertyType, actingUserId?: string): Promise<PropertyRow> {
      return withTransaction(pool, async (client) => {
        const property = await changePropertyTypeWithClient(client, id, newType);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: property.databaseId, userId: actingUserId }),
        );
        return property;
      });
    },

    /**
     * The single entry point for `PATCH /api/properties/:id` (issue #240): applies whichever of
     * `name`/`config`/`type` were sent in one transaction, so a 403 from the locked-schema checks
     * inside `updatePropertyConfigWithClient`/`changePropertyTypeWithClient` rolls back a rename
     * requested in the same call instead of leaving it silently committed against the caller's
     * expectation that a 403 response means nothing changed.
     */
    async updateProperty(
      id: string,
      input: { name?: string; config?: Record<string, unknown>; type?: PropertyType },
      actingUserId?: string,
    ): Promise<{ property: PropertyRow; typeChanged: boolean }> {
      return withTransaction(pool, async (client) => {
        let property = await propertiesStore.getProperty(client, id);
        if (!property) throw new NotFoundError(`Property ${id} not found`);

        // Issue #219: checked here, inside the same transaction as the existence check above,
        // so an unknown id is always 404 regardless of patch shape — a caller-side pre-check for
        // this would itself be an out-of-transaction read the existence check above already makes
        // redundant.
        if (input.name === undefined && input.config === undefined && input.type === undefined) {
          throw new ValidationError("Patch must include at least one field", { reason: "empty_patch" });
        }

        // Issue #219: re-checked against the row this same transaction just fetched, not a
        // caller-supplied snapshot — a concurrent type change between an outer read and this
        // write can't slip a type/config patch past a relation property this way.
        if (property.type === "relation" && (input.type !== undefined || input.config !== undefined)) {
          const field = input.type !== undefined ? "type" : "config";
          throw new ValidationError(
            `Property ${id} is a relation; ${field} is changed only via its relation definition`,
            { field, reason: "relation_definition_required" },
          );
        }

        if (input.name !== undefined) {
          property = await propertiesStore.renameProperty(client, id, input.name);
        }
        if (input.config !== undefined) {
          property = await updatePropertyConfigWithClient(client, id, input.config);
        }
        let typeChanged = false;
        if (input.type !== undefined && input.type !== property.type) {
          property = await changePropertyTypeWithClient(client, id, input.type);
          typeChanged = true;
        }
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: property.databaseId, userId: actingUserId }),
        );
        return { property, typeChanged };
      });
    },

    /**
     * Returns the row as it stood immediately before deletion (issue #219): fetched by this same
     * transaction, not a caller-supplied snapshot from a separate `getProperty` call — a rename
     * landing between a pre-check and this call could otherwise make a REST response describe a
     * state the deleted row never actually had at the moment it was deleted.
     */
    async deleteProperty(id: string, actingUserId?: string): Promise<PropertyRow> {
      return withTransaction(pool, (client) => propertyDeleteWithClient(client, id, actingUserId));
    },
  };
}

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
/**
 * Transaction-scoped counterpart to `chokePoint.softDeleteItem` (issue #89), factored out for the
 * same reason as `propertyDeleteWithClient` above. Runs the identical subtree cascade, including
 * the `systemActive`/archived-database guards and rollup/heartbeat side effects.
 */
export async function itemDeleteWithClient(
  client: PoolClient,
  databaseId: string,
  itemId: string,
  options: { queueAffinity: ActionQueueAffinity; actingUserId?: string },
): Promise<ItemRow | null> {
  await assertDatabaseNotArchived(client, databaseId);
  const before = await itemsStore.lockItemById(client, databaseId, itemId);
  if (!before) return null;
  if (before.properties.systemActive === true) {
    throw new ForbiddenError(`Item ${itemId} is a system-active project and cannot be deleted, only deactivated`, {
      field: "systemActive",
    });
  }
  if (before.deletedAt) return before;

  const subtree = await collectItemSubtree(client, before);
  for (const row of subtree) await assertDatabaseNotArchived(client, row.databaseId);

  let rootResult: ItemRow | null = null;
  for (const row of subtree) {
    const item = await itemsStore.softDeleteItem(client, row.databaseId, row.id);
    if (!item) continue;
    if (row.id === itemId) rootResult = item;
    await triggerOnItemEventHeartbeats(client, row.databaseId, "delete", row.id, options.queueAffinity);
    const edges = await relationsStore.listAllRelationsForItem(client, row.id);
    for (const edge of edges) await enqueueRollupRecomputeForEdge(client, edge);
    runAfterCommit(client, () =>
      notifyInvalidation({
        scope: "item",
        databaseId: item.databaseId,
        itemId: item.id,
        op: "delete",
        updatedAt: item.updatedAt,
        userId: options.actingUserId,
      }),
    );
  }
  return rootResult;
}

/**
 * Walks down from an already-fetched page item to every row nested underneath it — the inline
 * databases it owns directly (`databases.parent_item_id = itemId`), every item in each of those,
 * and recursively whatever inline databases *those* items own in turn — so delete/restore (issue
 * #156) can act on the whole subtree in one transaction instead of just the one row named by the
 * caller. Root-first order, BFS by level, root included as given (its `deletedAt` reflects the
 * state the caller read it in, before this transaction's own writes). Guards against a
 * `parent_item_id` cycle the same way `getItemPath` guards against one in the opposite direction:
 * tracking every database id already walked and refusing to walk it twice, so a corrupted loop
 * stops the traversal instead of hanging it.
 */
async function collectItemSubtree(client: PoolClient, root: ItemRow): Promise<ItemRow[]> {
  const subtree: ItemRow[] = [root];
  const visitedDatabaseIds = new Set<string>();
  let frontier = [root.id];

  while (frontier.length > 0) {
    const nextFrontier: string[] = [];
    for (const parentItemId of frontier) {
      const childDatabases = await databasesStore.listDatabasesByParentItem(client, parentItemId);
      for (const database of childDatabases) {
        if (visitedDatabaseIds.has(database.id)) continue;
        visitedDatabaseIds.add(database.id);
        const rows = await itemsStore.getAllItemsInDatabase(client, database.id);
        for (const row of rows) {
          subtree.push(row);
          nextFrontier.push(row.id);
        }
      }
    }
    frontier = nextFrontier;
  }
  return subtree;
}

function createItemTrashOps(deps: Pick<ChokePointDeps, "pool" | "queueAffinity">) {
  const { pool, queueAffinity } = deps;
  return {
    /**
     * Soft-deletes `itemId` and, in the same transaction, cascades to its whole subtree — every
     * inline database it owns and their rows, recursively (issue #156). Every database touched
     * anywhere in that subtree must be unarchived, or the entire cascade is rejected and nothing
     * is written; a database midway down the tree being archived is not a partial success.
     */
    async softDeleteItem(databaseId: string, itemId: string, actingUserId?: string): Promise<ItemRow | null> {
      return withTransaction(pool, (client) =>
        itemDeleteWithClient(client, databaseId, itemId, { queueAffinity, actingUserId }),
      );
    },

    /**
     * The exact cascade `softDeleteItem` runs, in reverse — restores `itemId` and its whole
     * subtree in one transaction, symmetric to how the delete side of it was trashed. Only
     * restores subtree rows whose `deletedAt` exactly matches the root's own `deletedAt`: since
     * Postgres's `now()` is fixed for the lifetime of a transaction, every row the original
     * cascade delete touched shares one identical timestamp, which lets this tell "trashed
     * together with the root" apart from a row that happened to already be independently trashed
     * (earlier or later) before this subtree was ever cascaded — restoring the latter would
     * silently resurrect data the user deleted on purpose.
     */
    async restoreItem(databaseId: string, itemId: string, actingUserId?: string): Promise<ItemRow | null> {
      return withTransaction(pool, async (client) => {
        await assertDatabaseNotArchived(client, databaseId);
        // Locked for the same reason `softDeleteItem` locks its root: without it, two concurrent
        // restores of the same item can both read `deletedAt` as set, both proceed, and the
        // second one's SQL-level `itemsStore.restoreItem` then finds nothing left to restore and
        // returns null — turning an already-successful restore into a spurious 404.
        const before = await itemsStore.lockItemById(client, databaseId, itemId);
        if (!before) return null;
        if (!before.deletedAt) return before; // not trashed: idempotent no-op, same as a repeat restore
        const cascadeEpoch = before.deletedAt;

        const subtree = await collectItemSubtree(client, before);
        for (const row of subtree) await assertDatabaseNotArchived(client, row.databaseId);

        let rootResult: ItemRow | null = null;
        for (const row of subtree) {
          if (row.deletedAt !== cascadeEpoch) continue; // not trashed together with the root: leave as-is
          const item = await itemsStore.restoreItem(client, row.databaseId, row.id);
          if (!item) continue;
          if (row.id === itemId) rootResult = item;
          const edges = await relationsStore.listAllRelationsForItem(client, row.id);
          for (const edge of edges) await enqueueRollupRecomputeForEdge(client, edge);
          runAfterCommit(client, () =>
            notifyInvalidation({
              scope: "item",
              databaseId: item.databaseId,
              itemId: item.id,
              op: "update",
              updatedAt: item.updatedAt,
              userId: actingUserId,
            }),
          );
        }
        return rootResult;
      });
    },

    /**
     * Permanently removes an already-eligible trashed root together with its cascade subtree —
     * the 30-day purge sweep's (`trash/purgeExpiredTrash.ts`, issue #156) only path to a hard
     * delete, so it stays a choke-point-guarded write like every other item mutation instead of a
     * second route into the `items` table. Mirrors `softDeleteItem`/`restoreItem`'s subtree walk,
     * but only descends into a branch that is itself past `cutoff`: a still-live or
     * too-recently-trashed row blocks the purge of everything nested under it, since only a
     * branch that was cascade-deleted together with the root is safe to remove with it. Re-checks
     * the root's own eligibility inside this transaction (rather than trusting the caller's
     * earlier candidate snapshot); that snapshot read is a plain, unlocked `SELECT`, so it alone
     * cannot stop a `restoreItem` from committing on one of these rows between this scan and the
     * delete loop below — the actual guard against that race is `itemsStore.hardDeleteItem`'s own
     * `deleted_at IS NOT NULL` condition, which turns a race-restored row's delete into a no-op
     * instead of destroying it. Rejects — and purges nothing — if any database in the eligible
     * subtree is archived, same as `softDeleteItem`/`restoreItem`. Returns the ids actually
     * removed (never one a concurrent restore raced ahead of), empty if the root turned out not
     * to be eligible.
     */
    async purgeExpiredTrashSubtree(rootItemId: string, cutoff: Date): Promise<string[]> {
      return withTransaction(pool, async (client) => {
        const [root] = await itemsStore.getItemsByIdsIncludingDeleted(client, [rootItemId]);
        if (!root || !root.deletedAt || new Date(root.deletedAt) >= cutoff) return [];

        const subtree: ItemRow[] = [root];
        const visitedDatabaseIds = new Set<string>();
        let frontier = [root.id];
        while (frontier.length > 0) {
          const nextFrontier: string[] = [];
          for (const parentItemId of frontier) {
            const childDatabases = await databasesStore.listDatabasesByParentItem(client, parentItemId);
            for (const database of childDatabases) {
              if (visitedDatabaseIds.has(database.id)) continue;
              visitedDatabaseIds.add(database.id);
              const rows = await itemsStore.getAllItemsInDatabase(client, database.id);
              for (const row of rows) {
                if (!row.deletedAt || new Date(row.deletedAt) >= cutoff) continue; // live or too fresh: branch stops here
                subtree.push(row);
                nextFrontier.push(row.id);
              }
            }
          }
          frontier = nextFrontier;
        }

        const subtreeDatabaseIds = new Set(subtree.map((row) => row.databaseId));
        for (const id of subtreeDatabaseIds) await assertDatabaseNotArchived(client, id);

        const purgedIds: string[] = [];
        for (const row of subtree) {
          const removed = await itemsStore.hardDeleteItem(client, row.databaseId, row.id);
          if (removed) purgedIds.push(row.id);
        }
        return purgedIds;
      });
    },
  };
}

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
