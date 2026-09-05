import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { assertValidTimezone } from "../timezone.js";
import type { CreatedBy, DatabaseRow, ItemRow, PropertyRow, PropertyType, ViewItemRow, ViewRow } from "../types.js";
import * as databasesStore from "./databasesStore.js";
import * as propertiesStore from "./propertiesStore.js";
import * as itemsStore from "./itemsStore.js";
import * as relationsStore from "./relationsStore.js";
import * as viewsStore from "./viewsStore.js";
import * as viewItemsStore from "./viewItemsStore.js";
import * as viewQuery from "../views/viewQuery.js";
import { compileFilterNode } from "../views/filterCompiler.js";
import { buildFilterProperties } from "../views/filterProperties.js";
import { parseFilterNode } from "../views/filterTree.js";
import { validateRollupConfig } from "../rollup/config.js";
import { findDependenciesByRelationDefinition, findDependenciesBySource, upsertRollupDependency } from "../rollup/dependencies.js";
import { enqueueRollupBackfill, enqueueRollupRecompute } from "../rollup/recompute.js";
import { assertRelationDeletable, assertSourceRetypeAllowed } from "../rollup/mirror.js";
import { enqueuePropertyTypeMigration, isConversionSupported } from "../migrationJob/propertyTypeMigration.js";
import { triggerOnItemEventHeartbeats, recomputeAllForTimezoneChange } from "../scheduler/schedulerStore.js";
import { createActionQueueAffinity, type ActionQueueAffinity } from "../scheduler/actions.js";
import { getSystemSettingsItemId } from "../systemSettings.js";
import { createComputedKeyRegistry, type ComputedKeyRegistry } from "./computedKeyRegistry.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "./viewTypeRegistry.js";

interface AssertWritablePropertiesOptions {
  /**
   * Relaxes the owner:'system' rejection below, but only for the exact keys listed — the one
   * narrow escape hatch for a trusted, code-defined system writer that is itself the module
   * contract's declared owning process for those specific fields (e.g. Journal's lazy item
   * creation is the owning process for exactly `name`/`type`/`period`, see
   * journal/journalStore.ts). Scoped per-key, not a blanket bypass, so a caller can't
   * accidentally (or a future caller couldn't deliberately) use it to write a *different*
   * database's system-owned field it was never granted. Never set from a request-handling path.
   */
  allowedSystemKeys?: readonly string[];
}

/** Keys the generic write path never accepts: relation values live only in item_relations, and computed is internal-only. */
function assertWritableProperties(properties: PropertyRow[], patchKeys: string[], options: AssertWritablePropertiesOptions = {}): void {
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
    if (property.owner === "system" && !options.allowedSystemKeys?.includes(key)) {
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

/**
 * Turns a caller-supplied filter tree into the `buildFilterSql` push-down hook the item
 * store expects. This is the one entry point through which a transport adapter (or any
 * other generic caller) filters items ad hoc — a stored view's filter goes the same way,
 * via views/viewQuery.ts — so no caller ever needs its own read path into `items`.
 */
async function buildFilterSqlForDatabase(client: PoolClient, databaseId: string, filter: unknown): Promise<(params: unknown[]) => string> {
  const properties = await propertiesStore.listPropertiesByDatabase(client, databaseId);
  const filterProperties = await buildFilterProperties(client, properties);
  const node = parseFilterNode(filter);
  return (params) => compileFilterNode(node, filterProperties, params);
}

/** `items.computed` is a shared namespace between rollup values and declared module cache keys — see computedKeyRegistry.ts. */
function assertNoComputedKeyCollision(registry: ComputedKeyRegistry, key: string): void {
  if (registry.has(key)) {
    throw new ValidationError(`Property key '${key}' collides with a declared module cache key`, { field: key });
  }
}

/** Shared by patch/delete on a view and every write to its `view_items` membership. */
function assertViewWritable(view: ViewRow, actor: CreatedBy): void {
  if (actor === "ai_agent" && view.createdBy !== "ai_agent") {
    throw new ForbiddenError(`View ${view.id} is owned by '${view.createdBy}' and cannot be written by an agent`, { field: "createdBy" }, "owner_violation");
  }
}

export interface CreateRelationPropertyInput {
  databaseId: string;
  key: string;
  name: string;
  targetDatabaseId: string;
  cardinality?: "one_to_one" | "one_to_many" | "many_to_many";
  inverse?: { key: string; name: string };
  locked?: boolean;
  owner?: "user" | "system";
}

/**
 * The relation-property creation logic, factored out so a caller already holding an open
 * transaction (namely the ten-hardcoded-databases seed, see seed/seedTenDatabases.ts) can
 * run it against that same `client` instead of going through `createChokePoint(...)`'s
 * `withTransaction`, which would open a second, separate connection — one that cannot see
 * this transaction's not-yet-committed `databases`/`properties` rows under read-committed
 * isolation. `createChokePoint`'s `createRelationProperty` below is a thin wrapper over this
 * for the normal, already-committed-schema case. The computed-key-collision check lives here
 * (not only in the public wrapper) so every caller of this exported function gets it, not
 * just the ones that happen to go through `createChokePoint`; `computedKeyRegistry` defaults
 * to a fresh empty registry, matching `createChokePoint`'s own default.
 */
export async function createRelationPropertyWithClient(
  client: PoolClient,
  input: CreateRelationPropertyInput,
  computedKeyRegistry: ComputedKeyRegistry = createComputedKeyRegistry(),
): Promise<{ property: PropertyRow; inverseProperty: PropertyRow | null }> {
  assertNoComputedKeyCollision(computedKeyRegistry, input.key);
  if (input.inverse) assertNoComputedKeyCollision(computedKeyRegistry, input.inverse.key);

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
}

export interface ListItemsInput extends itemsStore.ListItemsOptions {
  /** A filter tree (views/filterTree.ts), as a transport adapter receives it — validated here, never trusted. */
  filter?: unknown;
}

export interface CountItemsInput extends Pick<itemsStore.ListItemsOptions, "includeDeleted" | "buildFilterSql"> {
  filter?: unknown;
}

/**
 * Resolves the one filter a read runs under. `filter` (a tree) and `buildFilterSql` (a raw
 * push-down hook) are two ways of saying the same thing, so a caller passing both is
 * rejected rather than having one of them silently dropped — combining them would also be a
 * guess about whether they were meant to be ANDed.
 */
async function resolveFilterSql(
  client: PoolClient,
  databaseId: string,
  options: { filter?: unknown; buildFilterSql?: (params: unknown[]) => string | undefined },
): Promise<((params: unknown[]) => string | undefined) | undefined> {
  if (options.filter === undefined) return options.buildFilterSql;
  if (options.buildFilterSql) {
    throw new ValidationError("Pass either 'filter' or 'buildFilterSql', not both", { field: "filter" });
  }
  return buildFilterSqlForDatabase(client, databaseId, options.filter);
}

export interface CreateItemWithClientOptions extends AssertWritablePropertiesOptions {
  /** Queue affinity to route the onItemEvent heartbeat-fire job to, looked up by the matched heartbeat's action id. */
  queueAffinity?: ActionQueueAffinity;
}

export interface CreateItemInput {
  databaseId: string;
  properties?: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * The item-creation logic, factored out (same reason as `createRelationPropertyWithClient`
 * above) so a caller already holding an open transaction can run it against that same
 * `client` — namely `tasks/advanceTaskRecurrence.ts`, whose rolling-model advance must create
 * the next task instance, mark the old one done, and re-link its relations as a single
 * all-or-nothing transaction, and `journal/journalStore.ts`, whose lazy item creation writes
 * owner:'system' properties (`allowedSystemKeys`) as Journal's declared owning process for
 * exactly those keys. `createChokePoint(...)`'s `createItem` below is a thin wrapper over this.
 */
export async function createItemWithClient(client: PoolClient, input: CreateItemInput, options: CreateItemWithClientOptions = {}): Promise<ItemRow> {
  const properties = await propertiesStore.listPropertiesByDatabase(client, input.databaseId);
  assertWritableProperties(properties, Object.keys(input.properties ?? {}), options);

  const item = await itemsStore.insertItem(client, {
    databaseId: input.databaseId,
    properties: input.properties ?? {},
    idempotencyKey: input.idempotencyKey,
  });
  await triggerOnItemEventHeartbeats(client, input.databaseId, "create", item.id, options.queueAffinity);
  return item;
}

export interface UpdateItemInput {
  databaseId: string;
  itemId: string;
  propertiesPatch: Record<string, unknown>;
  ifVersion?: string;
}

export interface UpdateItemWithClientOptions extends AssertWritablePropertiesOptions {
  /** Queue affinity to route the onItemEvent heartbeat-fire job to, looked up by the matched heartbeat's action id. */
  queueAffinity?: ActionQueueAffinity;
}

/**
 * The item-update logic, factored out for the same reason as `createItemWithClient` above.
 * `options.allowedSystemKeys` (issue #25) mirrors `createItemWithClient`'s escape hatch: a
 * declared owning process — e.g. the library metadata heartbeat writing `cover` after an
 * item already exists — needs to patch its owner:'system' fields post-creation, not only
 * at insert time. `createChokePoint(...).updateItem` below never passes it, same as
 * `createItem`'s public wrapper.
 */
export async function updateItemWithClient(client: PoolClient, input: UpdateItemInput, options: UpdateItemWithClientOptions = {}): Promise<ItemRow> {
  const properties = await propertiesStore.listPropertiesByDatabase(client, input.databaseId);
  const patchKeys = Object.keys(input.propertiesPatch);
  assertWritableProperties(properties, patchKeys, options);

  const item = await itemsStore.updateItemProperties(client, {
    databaseId: input.databaseId,
    itemId: input.itemId,
    propertiesPatch: input.propertiesPatch,
    ifVersion: input.ifVersion,
  });
  await triggerOnItemEventHeartbeats(client, input.databaseId, "update", item.id, options.queueAffinity);

  for (const key of patchKeys) {
    const dependencies = await findDependenciesBySource(client, input.databaseId, key);
    for (const dependency of dependencies) {
      const edges = await relationsStore.listRelationsForItem(client, dependency.relationDefinitionId, item.id);
      for (const edge of edges) {
        await enqueueRollupRecompute(client, dependency.rollupPropertyId, relationsStore.otherSide(edge, item.id));
      }
    }
  }

  const settingsItemId = await getSystemSettingsItemId(client).catch((err) => {
    if (err instanceof NotFoundError) return null; // system not seeded yet
    throw err;
  });
  if (settingsItemId === item.id && typeof input.propertiesPatch.timezone === "string") {
    const timezone = input.propertiesPatch.timezone;
    // Validated before it reaches computeNextFireAt, where an invalid zone would surface
    // much later as a Postgres "Invalid time value" from serializing next_fire_at = NaN.
    assertValidTimezone(timezone);
    await recomputeAllForTimezoneChange(client, timezone);
  }

  return item;
}

export interface CreateRelationInput {
  relationPropertyId: string;
  itemId: string;
  targetItemId: string;
  metadata?: Record<string, unknown>;
}

/** The relation-linking logic, factored out for the same reason as `createItemWithClient` above. */
export async function createRelationWithClient(client: PoolClient, input: CreateRelationInput): Promise<void> {
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
}

export interface DeleteRelationInput {
  relationPropertyId: string;
  itemId: string;
  targetItemId: string;
}

/** The relation-unlinking counterpart to `createRelationWithClient` above, factored out for the same reason (issue #26: the IMAP adapter's VANISHED/UID-diff handling removes a folder-membership edge inside its own larger sync transaction). */
export async function deleteRelationWithClient(client: PoolClient, input: DeleteRelationInput): Promise<void> {
  const property = await propertiesStore.getProperty(client, input.relationPropertyId);
  if (!property || property.type !== "relation") {
    throw new ValidationError(`${input.relationPropertyId} is not a relation property`);
  }
  const reldef = await relationsStore.getRelationDefinitionByPropertyId(client, input.relationPropertyId);
  if (!reldef) throw new ValidationError(`Relation property ${input.relationPropertyId} has no relation definition`);

  const isSideA = reldef.propertyIdA === input.relationPropertyId;
  const itemA = isSideA ? input.itemId : input.targetItemId;
  const itemB = isSideA ? input.targetItemId : input.itemId;

  await relationsStore.deleteItemRelation(client, reldef.id, itemA, itemB);
  await enqueueRollupRecomputeForEdge(client, { relationDefinitionId: reldef.id, itemA, itemB });
}

export function createChokePoint(
  pool: Pool,
  computedKeyRegistry: ComputedKeyRegistry = createComputedKeyRegistry(),
  viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry(),
  queueAffinity: ActionQueueAffinity = createActionQueueAffinity(),
) {
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

    /** Inline database creation (issue #22, point 7): a new, independent database owned by a page. Always `system: false` — mechanically, since the input type carries no `system` field to override it. */
    async createInlineDatabase(input: {
      name: string;
      parentItemId: string;
      ownerProjectItemId?: string;
      ownerModuleId?: string;
    }): Promise<DatabaseRow> {
      return withTransaction(pool, (client) => databasesStore.createDatabase(client, { ...input, system: false }));
    },

    // ---- properties ----
    async listProperties(databaseId: string): Promise<PropertyRow[]> {
      return withTransaction(pool, (client) => propertiesStore.listPropertiesByDatabase(client, databaseId));
    },
    async getProperty(id: string): Promise<PropertyRow | null> {
      return withTransaction(pool, (client) => propertiesStore.getProperty(client, id));
    },

    async createProperty(input: propertiesStore.CreatePropertyInput): Promise<PropertyRow> {
      assertNoComputedKeyCollision(computedKeyRegistry, input.key);
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
    async createRelationProperty(input: CreateRelationPropertyInput): Promise<{ property: PropertyRow; inverseProperty: PropertyRow | null }> {
      return withTransaction(pool, (client) => createRelationPropertyWithClient(client, input, computedKeyRegistry));
    },

    // ---- relations (data side: linking two items) ----
    async createRelation(input: CreateRelationInput): Promise<void> {
      return withTransaction(pool, (client) => createRelationWithClient(client, input));
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
    async createItem(input: CreateItemInput): Promise<ItemRow> {
      return withTransaction(pool, (client) => createItemWithClient(client, input, { queueAffinity }));
    },

    async updateItem(input: UpdateItemInput): Promise<ItemRow> {
      return withTransaction(pool, (client) => updateItemWithClient(client, input, { queueAffinity }));
    },

    async getItem(databaseId: string, itemId: string): Promise<ItemRow | null> {
      return withTransaction(pool, (client) => itemsStore.getItemById(client, databaseId, itemId));
    },

    /** Filter with either `filter` (a filter tree, views/filterTree.ts) or `buildFilterSql`, never both. */
    async listItems(databaseId: string, options?: ListItemsInput) {
      return withTransaction(pool, async (client) => {
        // `filter` is consumed by resolveFilterSql; `rest` is what the store itself takes.
        const { filter, ...rest } = options ?? {};
        const buildFilterSql = await resolveFilterSql(client, databaseId, { filter, buildFilterSql: rest.buildFilterSql });
        return itemsStore.listItems(client, databaseId, { ...rest, buildFilterSql });
      });
    },

    /** The matching count for the same `filter` `listItems` takes — a count without paging the rows in. */
    async countItems(databaseId: string, options?: CountItemsInput): Promise<number> {
      return withTransaction(pool, async (client) => {
        const { filter, ...rest } = options ?? {};
        const buildFilterSql = await resolveFilterSql(client, databaseId, { filter, buildFilterSql: rest.buildFilterSql });
        return itemsStore.countItems(client, databaseId, { ...rest, buildFilterSql });
      });
    },

    async softDeleteItem(databaseId: string, itemId: string): Promise<ItemRow | null> {
      return withTransaction(pool, async (client) => {
        // A system-module project (issue #24's Projects.systemActive) "can only be
        // deactivated, never deleted" — checked generically on `properties.systemActive`
        // rather than hardcoded to the Projects database, so any future database adopting
        // the same convention is covered too. Row-locked (not a plain getItemById): without
        // the lock, a concurrent updateItem setting systemActive: true could commit between
        // this read and the delete below, slipping a delete through on what was, by the time
        // it mattered, a system-active item. The lock is held until this transaction commits,
        // so a concurrent writer blocks here instead of racing past the check.
        const before = await itemsStore.lockItemById(client, databaseId, itemId);
        if (before?.properties.systemActive === true) {
          throw new ForbiddenError(`Item ${itemId} is a system-active project and cannot be deleted, only deactivated`, { field: "systemActive" });
        }

        const item = await itemsStore.softDeleteItem(client, databaseId, itemId);
        if (!item) return null;
        await triggerOnItemEventHeartbeats(client, databaseId, "delete", itemId, queueAffinity);
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

    // ---- views ----
    async createView(input: viewsStore.CreateViewInput): Promise<ViewRow> {
      return withTransaction(pool, (client) => viewsStore.createView(client, input, viewTypeRegistry));
    },

    async getView(id: string): Promise<ViewRow | null> {
      return withTransaction(pool, (client) => viewsStore.getView(client, id));
    },

    async listViewsByDatabase(databaseId: string): Promise<ViewRow[]> {
      return withTransaction(pool, (client) => viewsStore.listViewsByDatabase(client, databaseId));
    },

    /** Curated views have no `databaseId` of their own, so they're listed separately rather than scoped to one database. */
    async listCuratedViews(): Promise<ViewRow[]> {
      return withTransaction(pool, (client) => viewsStore.listCuratedViews(client));
    },

    async patchView(input: { id: string; actor: CreatedBy; name?: string; config?: Record<string, unknown>; isDefault?: boolean }): Promise<ViewRow> {
      return withTransaction(pool, async (client) => {
        const view = await viewsStore.getView(client, input.id);
        if (!view) throw new NotFoundError(`View ${input.id} not found`);
        assertViewWritable(view, input.actor);
        if (input.actor === "ai_agent" && input.isDefault !== undefined) {
          throw new ForbiddenError("is_default cannot be set by an agent, not even on its own view", { field: "isDefault" }, "owner_violation");
        }
        // One-way adoption: a user's write to an agent's view flips it to 'user'; a system view is never flipped by a user write.
        const adopt = input.actor === "user" && view.createdBy === "ai_agent";
        return viewsStore.patchView(
          client,
          input.id,
          {
            name: input.name,
            config: input.config,
            isDefault: input.isDefault,
            createdBy: adopt ? "user" : undefined,
          },
          viewTypeRegistry,
        );
      });
    },

    async deleteView(input: { id: string; actor: CreatedBy }): Promise<void> {
      return withTransaction(pool, async (client) => {
        const view = await viewsStore.getView(client, input.id);
        if (!view) return;
        assertViewWritable(view, input.actor);
        await viewsStore.deleteView(client, input.id);
      });
    },

    // ---- view_items (curated view membership) ----
    async addViewItem(input: { viewId: string; itemId: string; position?: number; actor: CreatedBy }): Promise<ViewItemRow> {
      return withTransaction(pool, async (client) => {
        const view = await viewsStore.getView(client, input.viewId);
        if (!view) throw new NotFoundError(`View ${input.viewId} not found`);
        if (view.databaseId !== null) {
          throw new ValidationError("Only a curated view (databaseId = null) accepts view_items membership", { field: "viewId" });
        }
        assertViewWritable(view, input.actor);
        return viewItemsStore.addViewItem(client, input.viewId, input.itemId, input.position);
      });
    },

    async removeViewItem(input: { viewId: string; itemId: string; actor: CreatedBy }): Promise<void> {
      return withTransaction(pool, async (client) => {
        const view = await viewsStore.getView(client, input.viewId);
        if (!view) return;
        assertViewWritable(view, input.actor);
        await viewItemsStore.removeViewItem(client, input.viewId, input.itemId);
      });
    },

    async reorderViewItem(input: { viewId: string; itemId: string; position: number; actor: CreatedBy }): Promise<ViewItemRow> {
      return withTransaction(pool, async (client) => {
        const view = await viewsStore.getView(client, input.viewId);
        if (!view) throw new NotFoundError(`View ${input.viewId} not found`);
        assertViewWritable(view, input.actor);
        return viewItemsStore.reorderViewItem(client, input.viewId, input.itemId, input.position);
      });
    },

    async listViewItems(viewId: string): Promise<ViewItemRow[]> {
      return withTransaction(pool, (client) => viewItemsStore.listViewItems(client, viewId));
    },

    // ---- reading through a view: filter/sort/visibility push-down ----
    async queryView(viewId: string, options?: viewQuery.QueryViewOptions): Promise<viewQuery.QueryViewResult> {
      return withTransaction(pool, (client) => viewQuery.queryView(client, viewId, options));
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
  if (!targetDatabaseId) {
    // Should be unreachable once validateRollupConfig has passed (a relation property
    // always carries a target database) — guarded explicitly so a data inconsistency
    // surfaces as this message instead of a NOT NULL constraint violation on
    // rollup_dependencies.source_database_id.
    throw new ValidationError("Relation property has no targetDatabaseId in config", { field: "relationPropertyKey" });
  }

  await upsertRollupDependency(client, {
    rollupPropertyId: property.id,
    relationDefinitionId: reldef.id,
    sourceDatabaseId: targetDatabaseId,
    sourcePropertyKey: validated.targetProperty?.key ?? null,
  });
}

export type ChokePoint = ReturnType<typeof createChokePoint>;
