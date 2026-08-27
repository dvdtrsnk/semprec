import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { ForbiddenError, ValidationError } from "../errors.js";
import type { DatabaseRow, ItemRow, PropertyRow, PropertyType } from "../types.js";
import * as databasesStore from "./databasesStore.js";
import * as propertiesStore from "./propertiesStore.js";
import * as itemsStore from "./itemsStore.js";
import * as relationsStore from "./relationsStore.js";
import { validateRollupConfig } from "../rollup/config.js";
import { findDependenciesByRelationDefinition, findDependenciesBySource, upsertRollupDependency } from "../rollup/dependencies.js";
import { enqueueRollupBackfill, enqueueRollupRecompute } from "../rollup/recompute.js";
import { assertRelationDeletable, assertSourceRetypeAllowed } from "../rollup/mirror.js";
import { enqueuePropertyTypeMigration, isConversionSupported } from "../migrationJob/propertyTypeMigration.js";
import { triggerOnItemEventHeartbeats, recomputeAllForTimezoneChange } from "../scheduler/schedulerStore.js";
import { getSystemSettingsItemId } from "../systemSettings.js";

/** Keys the generic write path never accepts: relation values live only in item_relations, and computed is internal-only. */
function assertWritableProperties(properties: PropertyRow[], patchKeys: string[]): void {
  const byKey = new Map(properties.map((p) => [p.key, p]));
  for (const key of patchKeys) {
    const property = byKey.get(key);
    if (!property) {
      throw new ValidationError(`Unknown property key '${key}'`, { field: key });
    }
    if (property.type === "rollup") {
      // Rollup values live in items.computed, written only by the recompute worker —
      // matches the issue's "the generic update path refuses this field — computed_readonly, 403".
      throw new ForbiddenError(`Property '${key}' is a rollup; its value lives in computed and is read-only here`, { field: key }, "computed_readonly");
    }
    if (property.type === "relation") {
      throw new ValidationError(`Property '${key}' is a relation; write it via createRelation/deleteRelation, not item properties`, {
        field: key,
      });
    }
    if (property.owner === "system") {
      throw new ForbiddenError(`Property '${key}' is owned by 'system' and cannot be written by this caller`, { field: key });
    }
  }
}

async function resolveRollupRecomputeTargets(
  client: PoolClient,
  relationDefinitionId: string,
  itemA: string,
  itemB: string,
): Promise<Array<{ rollupPropertyId: string; itemId: string }>> {
  const dependencies = await findDependenciesByRelationDefinition(client, relationDefinitionId);
  if (dependencies.length === 0) return [];

  const reldef = await relationsStore.getRelationDefinition(client, relationDefinitionId);
  if (!reldef) return [];
  const propertyA = await propertiesStore.getProperty(client, reldef.propertyIdA);
  if (!propertyA) return [];

  const targets: Array<{ rollupPropertyId: string; itemId: string }> = [];
  for (const dependency of dependencies) {
    const rollupProperty = await propertiesStore.getProperty(client, dependency.rollupPropertyId);
    if (!rollupProperty) continue;
    const parentItemId = rollupProperty.databaseId === propertyA.databaseId ? itemA : itemB;
    targets.push({ rollupPropertyId: dependency.rollupPropertyId, itemId: parentItemId });
  }
  return targets;
}

async function enqueueRollupRecomputeForEdge(
  client: PoolClient,
  edge: { relationDefinitionId: string; itemA: string; itemB: string },
): Promise<void> {
  const targets = await resolveRollupRecomputeTargets(client, edge.relationDefinitionId, edge.itemA, edge.itemB);
  for (const target of targets) {
    await enqueueRollupRecompute(client, target.rollupPropertyId, target.itemId);
  }
}

export function createChokePoint(pool: Pool) {
  return {
    // ---- databases ----
    async createDatabase(input: databasesStore.CreateDatabaseInput): Promise<DatabaseRow> {
      return withTransaction(pool, (client) => databasesStore.createDatabase(client, input));
    },
    async archiveDatabase(id: string): Promise<DatabaseRow> {
      return withTransaction(pool, (client) => databasesStore.archiveDatabase(client, id));
    },
    async restoreDatabase(id: string): Promise<DatabaseRow> {
      return withTransaction(pool, (client) => databasesStore.restoreDatabase(client, id));
    },
    async getDatabase(id: string): Promise<DatabaseRow | null> {
      return withTransaction(pool, (client) => databasesStore.getDatabase(client, id));
    },

    // ---- properties ----
    async listProperties(databaseId: string): Promise<PropertyRow[]> {
      return withTransaction(pool, (client) => propertiesStore.listPropertiesByDatabase(client, databaseId));
    },
    async getProperty(id: string): Promise<PropertyRow | null> {
      return withTransaction(pool, (client) => propertiesStore.getProperty(client, id));
    },

    async createProperty(input: propertiesStore.CreatePropertyInput): Promise<PropertyRow> {
      if (input.type === "rollup") {
        return withTransaction(pool, async (client) => {
          const property = await propertiesStore.createProperty(client, input);
          await applyRollupConfig(client, property);
          await enqueueRollupBackfill(client, property.id);
          return propertiesStore.getProperty(client, property.id) as Promise<PropertyRow>;
        });
      }
      return withTransaction(pool, (client) => propertiesStore.createProperty(client, input));
    },

    async renameProperty(id: string, name: string): Promise<PropertyRow> {
      return withTransaction(pool, (client) => propertiesStore.renameProperty(client, id, name));
    },

    async updatePropertyConfig(id: string, config: Record<string, unknown>): Promise<PropertyRow> {
      return withTransaction(pool, async (client) => {
        const property = await propertiesStore.updatePropertyConfig(client, id, config);
        if (property.type === "rollup") {
          await applyRollupConfig(client, property);
          await enqueueRollupBackfill(client, property.id);
        }
        return property;
      });
    },

    async changePropertyType(id: string, newType: PropertyType): Promise<PropertyRow> {
      return withTransaction(pool, async (client) => {
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
      });
    },

    async deleteProperty(id: string): Promise<void> {
      return withTransaction(pool, async (client) => {
        const property = await propertiesStore.getProperty(client, id);
        if (!property) return;

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
              await propertiesStore.deleteProperty(client, otherPropertyId);
            }
          }
        }
        await propertiesStore.deleteProperty(client, id);
      });
    },

    // ---- relations (schema side: creating a paired relation property) ----
    async createRelationProperty(input: {
      databaseId: string;
      key: string;
      name: string;
      targetDatabaseId: string;
      cardinality?: "one_to_one" | "one_to_many" | "many_to_many";
      inverse?: { key: string; name: string };
      locked?: boolean;
      owner?: "user" | "system";
    }): Promise<{ property: PropertyRow; inverseProperty: PropertyRow | null }> {
      return withTransaction(pool, async (client) => {
        const property = await propertiesStore.createProperty(client, {
          databaseId: input.databaseId,
          key: input.key,
          name: input.name,
          type: "relation",
          locked: input.locked,
          owner: input.owner,
        });

        let inverseProperty: PropertyRow | null = null;
        if (input.inverse) {
          inverseProperty = await propertiesStore.createProperty(client, {
            databaseId: input.targetDatabaseId,
            key: input.inverse.key,
            name: input.inverse.name,
            type: "relation",
          });
        }

        const reldef = await relationsStore.createRelationDefinition(client, {
          propertyIdA: property.id,
          propertyIdB: inverseProperty?.id,
          cardinality: input.cardinality,
        });

        const finalProperty = await propertiesStore.updatePropertyConfig(client, property.id, {
          relationDefinitionId: reldef.id,
          targetDatabaseId: input.targetDatabaseId,
        });
        if (inverseProperty) {
          inverseProperty = await propertiesStore.updatePropertyConfig(client, inverseProperty.id, {
            relationDefinitionId: reldef.id,
            targetDatabaseId: input.databaseId,
          });
        }
        return { property: finalProperty, inverseProperty };
      });
    },

    // ---- relations (data side: linking two items) ----
    async createRelation(input: { relationPropertyId: string; itemId: string; targetItemId: string; metadata?: Record<string, unknown> }): Promise<void> {
      return withTransaction(pool, async (client) => {
        const property = await propertiesStore.getProperty(client, input.relationPropertyId);
        if (!property || property.type !== "relation") {
          throw new ValidationError(`${input.relationPropertyId} is not a relation property`);
        }
        const reldef = await relationsStore.getRelationDefinitionByPropertyId(client, input.relationPropertyId);
        if (!reldef) throw new ValidationError(`Relation property ${input.relationPropertyId} has no relation definition`);

        const isSideA = reldef.propertyIdA === input.relationPropertyId;
        const itemA = isSideA ? input.itemId : input.targetItemId;
        const itemB = isSideA ? input.targetItemId : input.itemId;

        await relationsStore.createItemRelation(client, {
          relationDefinitionId: reldef.id,
          itemA,
          itemB,
          metadata: input.metadata,
        });
        await enqueueRollupRecomputeForEdge(client, { relationDefinitionId: reldef.id, itemA, itemB });
      });
    },

    async deleteRelation(input: { relationPropertyId: string; itemId: string; targetItemId: string }): Promise<void> {
      return withTransaction(pool, async (client) => {
        const reldef = await relationsStore.getRelationDefinitionByPropertyId(client, input.relationPropertyId);
        if (!reldef) throw new ValidationError(`Relation property ${input.relationPropertyId} has no relation definition`);

        const isSideA = reldef.propertyIdA === input.relationPropertyId;
        const itemA = isSideA ? input.itemId : input.targetItemId;
        const itemB = isSideA ? input.targetItemId : input.itemId;

        await relationsStore.deleteItemRelation(client, reldef.id, itemA, itemB);
        await enqueueRollupRecomputeForEdge(client, { relationDefinitionId: reldef.id, itemA, itemB });
      });
    },

    // ---- items ----
    async createItem(input: { databaseId: string; properties?: Record<string, unknown>; idempotencyKey?: string }): Promise<ItemRow> {
      return withTransaction(pool, async (client) => {
        const properties = await propertiesStore.listPropertiesByDatabase(client, input.databaseId);
        assertWritableProperties(properties, Object.keys(input.properties ?? {}));

        const item = await itemsStore.insertItem(client, {
          databaseId: input.databaseId,
          properties: input.properties ?? {},
          idempotencyKey: input.idempotencyKey,
        });
        await triggerOnItemEventHeartbeats(client, input.databaseId, "create", item.id);
        return item;
      });
    },

    async updateItem(input: {
      databaseId: string;
      itemId: string;
      propertiesPatch: Record<string, unknown>;
      ifVersion?: string;
    }): Promise<ItemRow> {
      return withTransaction(pool, async (client) => {
        const properties = await propertiesStore.listPropertiesByDatabase(client, input.databaseId);
        const patchKeys = Object.keys(input.propertiesPatch);
        assertWritableProperties(properties, patchKeys);

        const item = await itemsStore.updateItemProperties(client, {
          databaseId: input.databaseId,
          itemId: input.itemId,
          propertiesPatch: input.propertiesPatch,
          ifVersion: input.ifVersion,
        });
        await triggerOnItemEventHeartbeats(client, input.databaseId, "update", item.id);

        for (const key of patchKeys) {
          const dependencies = await findDependenciesBySource(client, input.databaseId, key);
          for (const dependency of dependencies) {
            const edges = await relationsStore.listRelationsForItem(client, dependency.relationDefinitionId, item.id);
            for (const edge of edges) {
              await enqueueRollupRecompute(client, dependency.rollupPropertyId, relationsStore.otherSide(edge, item.id));
            }
          }
        }

        const settingsItemId = await getSystemSettingsItemId(client).catch(() => null);
        if (settingsItemId === item.id && typeof input.propertiesPatch.timezone === "string") {
          await recomputeAllForTimezoneChange(client, input.propertiesPatch.timezone);
        }

        return item;
      });
    },

    async getItem(databaseId: string, itemId: string): Promise<ItemRow | null> {
      return withTransaction(pool, (client) => itemsStore.getItemById(client, databaseId, itemId));
    },

    async listItems(databaseId: string, options?: itemsStore.ListItemsOptions) {
      return withTransaction(pool, (client) => itemsStore.listItems(client, databaseId, options));
    },

    async softDeleteItem(databaseId: string, itemId: string): Promise<ItemRow | null> {
      return withTransaction(pool, async (client) => {
        const item = await itemsStore.softDeleteItem(client, databaseId, itemId);
        if (!item) return null;
        await triggerOnItemEventHeartbeats(client, databaseId, "delete", itemId);
        const edges = await relationsStore.listAllRelationsForItem(client, itemId);
        for (const edge of edges) await enqueueRollupRecomputeForEdge(client, edge);
        return item;
      });
    },

    async restoreItem(databaseId: string, itemId: string): Promise<ItemRow | null> {
      return withTransaction(pool, async (client) => {
        const item = await itemsStore.restoreItem(client, databaseId, itemId);
        if (!item) return null;
        const edges = await relationsStore.listAllRelationsForItem(client, itemId);
        for (const edge of edges) await enqueueRollupRecomputeForEdge(client, edge);
        return item;
      });
    },
  };
}

async function applyRollupConfig(client: PoolClient, property: PropertyRow): Promise<void> {
  const sameDatabaseProperties = await propertiesStore.listPropertiesByDatabase(client, property.databaseId);
  const relationProperty = sameDatabaseProperties.find((p) => p.key === (property.config as { relationPropertyKey?: string }).relationPropertyKey);
  const targetDatabaseId = relationProperty ? (relationProperty.config as { targetDatabaseId?: string }).targetDatabaseId : undefined;
  const targetDatabaseProperties = targetDatabaseId ? await propertiesStore.listPropertiesByDatabase(client, targetDatabaseId) : [];

  const validated = validateRollupConfig(property.config, sameDatabaseProperties, targetDatabaseProperties);
  const reldef = await relationsStore.getRelationDefinitionByPropertyId(client, validated.relationProperty.id);
  if (!reldef) {
    throw new ValidationError(`Relation property '${validated.relationProperty.key}' has no relation definition`, {
      field: "relationPropertyKey",
    });
  }

  await upsertRollupDependency(client, {
    rollupPropertyId: property.id,
    relationDefinitionId: reldef.id,
    sourceDatabaseId: targetDatabaseId as string,
    sourcePropertyKey: validated.targetProperty?.key ?? null,
  });
}

export type ChokePoint = ReturnType<typeof createChokePoint>;
