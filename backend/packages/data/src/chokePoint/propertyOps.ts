// Owns the properties domain of the choke point: listing, reading and resolving properties, creating,
// renaming, reconfiguring, retyping and deleting them, plus the transaction-scoped
// `propertyDeleteWithClient` the approved-operation executor calls. Relation-definition writes (the
// paired relation properties themselves), item, view and database writes do not belong here, and
// neither does any other domain module's code.
// Constrained by:
// - docs/adr/2026-09-12-thin-user-scoped-realtime-invalidations.md
// - docs/adr/2026-09-18-exactly-once-execution-of-approved-destructive-operations.md
import type { PoolClient } from "pg";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import type { PropertyRow, PropertyType } from "../types.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import * as propertiesStore from "./propertiesStore.js";
import * as relationsStore from "./relationsStore.js";
import { assertNoComputedKeyCollision } from "./computedKeyRegistry.js";
import { applyRollupConfig } from "../rollup/config.js";
import { enqueueRollupBackfill } from "../rollup/recompute.js";
import { assertRelationDeletable, assertSourceRetypeAllowed } from "../rollup/mirror.js";
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

export function createPropertyOps(deps: Pick<ChokePointDeps, "pool" | "computedKeyRegistry">) {
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
