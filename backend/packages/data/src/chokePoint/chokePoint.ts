import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { assertValidTimezone } from "../timezone.js";
import type {
  CreatedBy,
  DatabaseRow,
  ItemRelationRow,
  ItemRow,
  PropertyOwner,
  PropertyRow,
  PropertyType,
  RelationDefinitionRow,
  ViewItemRow,
  ViewRow,
} from "../types.js";
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
import {
  findDependenciesByRelationDefinition,
  findDependenciesBySource,
  upsertRollupDependency,
} from "../rollup/dependencies.js";
import { enqueueRollupBackfill, enqueueRollupRecompute } from "../rollup/recompute.js";
import { assertRelationDeletable, assertSourceRetypeAllowed } from "../rollup/mirror.js";
import { enqueuePropertyTypeMigration, isConversionSupported } from "../migrationJob/propertyTypeMigration.js";
import { triggerOnItemEventHeartbeats, recomputeAllForTimezoneChange } from "../scheduler/schedulerStore.js";
import { createActionQueueAffinity, type ActionQueueAffinity } from "../scheduler/actions.js";
import { getSystemSettingsItemId } from "../systemSettings.js";
import { createComputedKeyRegistry, type ComputedKeyRegistry } from "./computedKeyRegistry.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "./viewTypeRegistry.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";

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
function assertWritableProperties(
  properties: PropertyRow[],
  patchKeys: string[],
  options: AssertWritablePropertiesOptions = {},
): void {
  const byKey = new Map(properties.map((p) => [p.key, p]));
  for (const key of patchKeys) {
    const property = byKey.get(key);
    if (!property) {
      throw new ValidationError(`Unknown property key '${key}'`, { field: key });
    }
    if (property.type === "rollup") {
      // Rollup values live in items.computed, written only by the recompute worker —
      // matches the issue's "the generic update path refuses this field — computed_readonly, 403".
      throw new ForbiddenError(
        `Property '${key}' is a rollup; its value lives in computed and is read-only here`,
        { field: key },
        "computed_readonly",
      );
    }
    if (property.type === "relation") {
      throw new ValidationError(
        `Property '${key}' is a relation; write it via createRelation/deleteRelation, not item properties`,
        {
          field: key,
        },
      );
    }
    if (property.owner === "system" && !options.allowedSystemKeys?.includes(key)) {
      throw new ForbiddenError(`Property '${key}' is owned by 'system' and cannot be written by this caller`, {
        field: key,
      });
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

/** Exported so a module-specific delete that unlinks relations outside `softDeleteItem` (e.g. inbox/inboxTypesStore.ts's `deleteInboxTypeWithClient`) can enqueue the same rollup recompute per edge it removes. */
export async function enqueueRollupRecomputeForEdge(
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
async function buildFilterSqlForDatabase(
  client: PoolClient,
  databaseId: string,
  filter: unknown,
): Promise<(params: unknown[]) => string> {
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

/**
 * The one reusable archived-database guard: blocks every item/relation mutation against an
 * archived database with a canonical 403 `database_archived`, while reads (and restoring the
 * database itself) remain unaffected. Used directly by every mutation below except item
 * creation, which needs the idempotent-replay carve-out in `assertDatabaseWritableForCreate`.
 */
async function assertDatabaseNotArchived(client: PoolClient, databaseId: string): Promise<void> {
  const database = await databasesStore.getDatabase(client, databaseId);
  if (!database) throw new NotFoundError(`Database ${databaseId} not found`);
  if (database.archivedAt) {
    throw new ForbiddenError(
      `Database ${databaseId} is archived and cannot be written to`,
      { field: "databaseId" },
      "database_archived",
    );
  }
}

/**
 * Item creation's own archived-database guard: unlike every other mutation, a create must let
 * through the one no-write exception the issue carves out — a replay of an idempotency key
 * that already committed a row before the database was archived returns that existing row
 * instead of failing, so a retried request doesn't turn a transient error into a permanent
 * failure. A new key, or a key reserved for this database whose row is somehow missing (see
 * the same defensive branch in `itemsStore.insertItem`), still gets `database_archived` — only
 * an exact, already-satisfied replay is spared. Returns the replay row to return verbatim (no
 * further writes or event emission), or `null` when the database isn't archived at all.
 */
async function assertDatabaseWritableForCreate(
  client: PoolClient,
  databaseId: string,
  idempotencyKey: string | undefined,
): Promise<ItemRow | null> {
  const database = await databasesStore.getDatabase(client, databaseId);
  if (!database) throw new NotFoundError(`Database ${databaseId} not found`);
  if (!database.archivedAt) return null;

  if (idempotencyKey) {
    const replay = await itemsStore.findIdempotentReplay(client, databaseId, idempotencyKey);
    if (replay) return replay;
  }
  throw new ForbiddenError(
    `Database ${databaseId} is archived and cannot be written to`,
    { field: "databaseId" },
    "database_archived",
  );
}

/** Shared by every relation-edge mutation: both the caller's own database and the edge's target database must be unarchived, since an edge write touches an item on each side. */
async function assertRelationDatabasesNotArchived(client: PoolClient, context: RelationEdgeContext): Promise<void> {
  await assertDatabaseNotArchived(client, context.property.databaseId);
  await assertDatabaseNotArchived(client, context.targetDatabaseId);
}

/**
 * The caller identity every view/view_items write is checked against (issue #87). `type`
 * mirrors `CreatedBy` (the write's intended kind); `agentProjectItemId` is the server-derived
 * owning Projects item id for an authenticated agent caller — required when `type ===
 * 'ai_agent'`, never present otherwise, and never accepted from a request body (it is set only
 * by whatever authenticates the caller, upstream of the choke-point).
 */
export interface Actor {
  type: CreatedBy;
  agentProjectItemId?: string;
}

/** `view_items` carries no FK to `items` (partitioned, no single partition key) — this is the live existence check `addViewItem` runs in its place. */
async function assertItemExists(client: PoolClient, itemId: string): Promise<void> {
  const [item] = await itemsStore.getItemsByIds(client, [itemId]);
  if (!item) throw new NotFoundError(`Item ${itemId} not found`);
}

function ownerViolation(view: { id: string }, reason: string): ForbiddenError {
  return new ForbiddenError(
    `View ${view.id} write rejected by owner_violation: ${reason}`,
    { field: "creatorProjectItemId", viewId: view.id, reason },
    "owner_violation",
  );
}

/**
 * Every agent-actor write (view row or `view_items` membership) proves its identity before
 * touching any row: a missing `agentProjectItemId` or one that names no real Projects item is
 * rejected outright, so a cross-agent or legacy-owner check never runs against a forged or
 * dangling identity. A no-op for a 'user'/'system' actor.
 * See [[2026-09-10-agent-identity-verified-against-projects-items]] for why this is a live
 * lookup rather than an FK (partitioned `items` can't express one).
 */
async function assertAuthenticatedAgentIdentity(client: PoolClient, actor: Actor): Promise<void> {
  if (actor.type !== "ai_agent") return;
  if (!actor.agentProjectItemId) {
    throw new ForbiddenError(
      "An agent actor requires actor.agentProjectItemId",
      { field: "agentProjectItemId", reason: "missing_authenticated_agent_identity" },
      "owner_violation",
    );
  }
  const projectsDatabase = await databasesStore.getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
  if (!projectsDatabase) {
    throw new ForbiddenError(
      "The Projects system database does not exist, so no agent identity can be verified",
      { field: "agentProjectItemId", reason: "unknown_authenticated_agent_identity" },
      "owner_violation",
    );
  }
  const projectItem = await itemsStore.getItemById(client, projectsDatabase.id, actor.agentProjectItemId);
  if (!projectItem || projectItem.deletedAt) {
    throw new ForbiddenError(
      `Projects item ${actor.agentProjectItemId} does not exist`,
      { field: "agentProjectItemId", reason: "unknown_authenticated_agent_identity" },
      "owner_violation",
    );
  }
}

/**
 * One-way adoption (issue #87): a user's write — patch or curated-membership mutation — to an
 * agent-owned view flips it to 'user' and clears the creator identity, in the same transaction
 * as (and before) the mutation itself. A system view is never adopted: it never has
 * `createdBy === 'ai_agent'`, so the condition below is false for it by construction.
 */
async function adoptIfUserWrite(
  client: PoolClient,
  view: ViewRow,
  actor: Actor,
  viewTypeRegistry: ViewTypeRegistry,
): Promise<void> {
  if (actor.type === "user" && view.createdBy === "ai_agent") {
    await viewsStore.patchView(client, view.id, { createdBy: "user", creatorProjectItemId: null }, viewTypeRegistry);
  }
}

/** Shared by patch/delete on a view and every write to its `view_items` membership. A no-op for a 'user'/'system' actor — only an agent write is ownership-checked here. */
function assertViewWritable(view: ViewRow, actor: Actor): void {
  if (actor.type !== "ai_agent") return;
  switch (view.createdBy) {
    case "system":
      throw ownerViolation(view, "system_owned");
    case "user":
      throw ownerViolation(view, "user_owned");
    case "ai_agent":
      if (view.creatorProjectItemId === null) throw ownerViolation(view, "legacy_creator_unknown");
      if (view.creatorProjectItemId !== actor.agentProjectItemId) throw ownerViolation(view, "creator_mismatch");
      return;
    default: {
      const exhaustive: never = view.createdBy;
      throw new Error(`Unhandled CreatedBy value: ${String(exhaustive)}`);
    }
  }
}

/** Proves the caller's process identity for a protected system relation write — see `assertRelationSideCreatable`/`assertRelationPropertyWritable` below. Never accepted on the public facade. */
export interface SystemRelationWriteContext {
  ownerProcess: string;
}

export interface RelationPropertySideInput {
  key: string;
  /** Nullable for a built-in relation property of a system database (issue #235). */
  name: string | null;
  owner?: PropertyOwner;
  /** Required and non-empty exactly when `owner` is `'system'`; must be omitted otherwise. */
  ownerProcess?: string;
  /** This side's own lock state — never inherited from the source side's `locked` (see `CreateRelationPropertyInput.locked`). Defaults to `false`. */
  locked?: boolean;
}

export interface CreateRelationPropertyInput {
  sourceDatabaseId: string;
  key: string;
  /** Nullable for a built-in relation property of a system database (issue #235). */
  name: string | null;
  targetDatabaseId: string;
  cardinality?: "one_to_one" | "one_to_many" | "many_to_many";
  owner?: PropertyOwner;
  /** Required and non-empty exactly when `owner` is `'system'`; must be omitted otherwise. */
  ownerProcess?: string;
  /**
   * Locks only the source side (`property_id_a`). Each side's lock is independent — set
   * `inverse.locked` too if the paired property must also be locked. Before this issue,
   * a single top-level `locked: true` locked both sides of a pair; a caller migrating onto
   * this shape must now set `inverse.locked: true` explicitly, or the inverse property is
   * created unlocked.
   */
  locked?: boolean;
  inverse?: RelationPropertySideInput;
}

/** `ownerProcess` is required and non-empty exactly when `owner` is `'system'`, and must be absent otherwise — enforced per side, independently. */
function assertValidOwnerSide(owner: PropertyOwner, ownerProcess: string | undefined, field: string): void {
  if (owner === "system") {
    if (!ownerProcess) {
      throw new ValidationError(`${field}.ownerProcess is required and non-empty when ${field}.owner is 'system'`, {
        field: `${field}.ownerProcess`,
      });
    }
  } else if (ownerProcess !== undefined) {
    throw new ValidationError(`${field}.ownerProcess must be omitted unless ${field}.owner is 'system'`, {
      field: `${field}.ownerProcess`,
    });
  }
}

/** A public caller (no context) may only create `owner: 'user'` sides; a protected system caller may create an `owner: 'system'` side only when its context matches that side's declared `ownerProcess`. */
function assertRelationSideCreatable(
  owner: PropertyOwner,
  ownerProcess: string | undefined,
  context: SystemRelationWriteContext | undefined,
  field: string,
): void {
  if (owner !== "system") return;
  if (!context || context.ownerProcess !== ownerProcess) {
    throw new ForbiddenError(
      `Creating ${field} as owner:'system' requires a matching SystemRelationWriteContext`,
      { field },
      "owner_violation",
    );
  }
}

/**
 * The relation-property creation logic, factored out so a caller already holding an open
 * transaction (namely the ten-hardcoded-databases seed, see seed/seedTenDatabases.ts) can
 * run it against that same `client` instead of going through `createChokePoint(...)`'s
 * `withTransaction`, which would open a second, separate connection — one that cannot see
 * this transaction's not-yet-committed `databases`/`properties` rows under read-committed
 * isolation. `createChokePoint`'s `createRelationProperty` below is a thin wrapper over this
 * for the normal, already-committed-schema case, always called with no `context` — so a
 * public caller can never create an `owner: 'system'` side (see `assertRelationSideCreatable`).
 * The computed-key-collision check lives here (not only in the public wrapper) so every
 * caller of this exported function gets it, not just the ones that happen to go through
 * `createChokePoint`; `computedKeyRegistry` defaults to a fresh empty registry, matching
 * `createChokePoint`'s own default.
 *
 * Both sides' schema (property + config) are created before either side's `locked` is
 * applied, so a `locked: true` request never has an externally visible intermediate state —
 * a concurrent reader in another transaction sees either the whole thing committed, unlocked
 * schema and all, or nothing at all.
 */
export async function createRelationPropertyWithClient(
  client: PoolClient,
  input: CreateRelationPropertyInput,
  context?: SystemRelationWriteContext,
  computedKeyRegistry: ComputedKeyRegistry = createComputedKeyRegistry(),
): Promise<{ property: PropertyRow; inverseProperty: PropertyRow | null }> {
  assertNoComputedKeyCollision(computedKeyRegistry, input.key);
  if (input.inverse) assertNoComputedKeyCollision(computedKeyRegistry, input.inverse.key);

  const sourceOwner: PropertyOwner = input.owner ?? "user";
  assertValidOwnerSide(sourceOwner, input.ownerProcess, "source");
  assertRelationSideCreatable(sourceOwner, input.ownerProcess, context, "source");

  const inverseOwner: PropertyOwner | undefined = input.inverse ? (input.inverse.owner ?? "user") : undefined;
  if (input.inverse) {
    assertValidOwnerSide(inverseOwner!, input.inverse.ownerProcess, "inverse");
    assertRelationSideCreatable(inverseOwner!, input.inverse.ownerProcess, context, "inverse");
  }

  const targetDatabase = await databasesStore.getDatabase(client, input.targetDatabaseId);
  if (!targetDatabase) {
    throw new ValidationError(`Target database ${input.targetDatabaseId} does not exist`, {
      field: "targetDatabaseId",
    });
  }

  const property = await propertiesStore.createProperty(client, {
    databaseId: input.sourceDatabaseId,
    key: input.key,
    name: input.name,
    type: "relation",
    owner: sourceOwner,
    ownerProcess: input.ownerProcess,
  });

  let inverseProperty: PropertyRow | null = null;
  if (input.inverse) {
    inverseProperty = await propertiesStore.createProperty(client, {
      databaseId: input.targetDatabaseId,
      key: input.inverse.key,
      name: input.inverse.name,
      type: "relation",
      owner: inverseOwner,
      ownerProcess: input.inverse.ownerProcess,
    });
  }

  const reldef = await relationsStore.createRelationDefinition(client, {
    propertyIdA: property.id,
    propertyIdB: inverseProperty?.id,
    cardinality: input.cardinality,
  });

  let finalProperty = await propertiesStore.updatePropertyConfig(client, property.id, {
    relationDefinitionId: reldef.id,
    targetDatabaseId: input.targetDatabaseId,
  });
  if (inverseProperty) {
    inverseProperty = await propertiesStore.updatePropertyConfig(client, inverseProperty.id, {
      relationDefinitionId: reldef.id,
      targetDatabaseId: input.sourceDatabaseId,
    });
  }
  if (input.locked) {
    await propertiesStore.setPropertyLocked(client, finalProperty.id, true);
    finalProperty = { ...finalProperty, locked: true };
  }
  if (inverseProperty && input.inverse?.locked) {
    await propertiesStore.setPropertyLocked(client, inverseProperty.id, true);
    inverseProperty = { ...inverseProperty, locked: true };
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
export async function createItemWithClient(
  client: PoolClient,
  input: CreateItemInput,
  options: CreateItemWithClientOptions = {},
): Promise<ItemRow> {
  const replay = await assertDatabaseWritableForCreate(client, input.databaseId, input.idempotencyKey);
  if (replay) return replay;

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
export async function updateItemWithClient(
  client: PoolClient,
  input: UpdateItemInput,
  options: UpdateItemWithClientOptions = {},
): Promise<ItemRow> {
  await assertDatabaseNotArchived(client, input.databaseId);
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

interface RelationEdgeContext {
  reldef: RelationDefinitionRow;
  property: PropertyRow;
  targetDatabaseId: string;
}

/**
 * Loads the relation property named by an edge input and normalizes it against its relation
 * definition. `relationPropertyId` always identifies the caller's own side of the definition;
 * its `config.relationDefinitionId`/`config.targetDatabaseId` are the only source of truth for
 * which definition and target database an edge call resolves against — a property whose config
 * lacks either is a data inconsistency (a relation property is never usable before
 * `createRelationPropertyWithClient` fills in both), not a case to infer around.
 */
async function loadRelationEdgeContext(client: PoolClient, relationPropertyId: string): Promise<RelationEdgeContext> {
  const property = await propertiesStore.getProperty(client, relationPropertyId);
  if (!property || property.type !== "relation") {
    throw new ValidationError(`${relationPropertyId} is not a relation property`, { field: "relationPropertyId" });
  }
  const config = property.config as { relationDefinitionId?: unknown; targetDatabaseId?: unknown };
  if (typeof config.relationDefinitionId !== "string" || typeof config.targetDatabaseId !== "string") {
    throw new ValidationError(
      `Relation property ${relationPropertyId} is missing a valid relationDefinitionId/targetDatabaseId`,
      {
        field: "relationPropertyId",
      },
    );
  }
  const reldef = await relationsStore.getRelationDefinition(client, config.relationDefinitionId);
  if (!reldef || (reldef.propertyIdA !== relationPropertyId && reldef.propertyIdB !== relationPropertyId)) {
    throw new ValidationError(`Relation property ${relationPropertyId} has no matching relation definition`, {
      field: "relationPropertyId",
    });
  }
  return { reldef, property, targetDatabaseId: config.targetDatabaseId };
}

/** Normalizes a caller/target pair to the stored item A / item B tuple for the definition's own side. */
function normalizeRelationSides(
  reldef: RelationDefinitionRow,
  relationPropertyId: string,
  callerItemId: string,
  targetItemId: string,
): { itemA: string; itemB: string } {
  const isSideA = reldef.propertyIdA === relationPropertyId;
  return isSideA ? { itemA: callerItemId, itemB: targetItemId } : { itemA: targetItemId, itemB: callerItemId };
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

/**
 * Authorizes an edge write against the exact property named by `relationPropertyId` — a
 * paired definition's two sides may have different owners, and only the side the caller
 * named governs this particular call. A public caller (no context) is rejected outright when
 * that side is `owner: 'system'`; a protected system caller is rejected unless its
 * `context.ownerProcess` matches the property's declared `owner_process` exactly.
 */
function assertRelationPropertyWritable(property: PropertyRow, context: SystemRelationWriteContext | undefined): void {
  if (property.owner !== "system") return;
  if (!context || context.ownerProcess !== property.ownerProcess) {
    throw new ForbiddenError(
      `Relation property ${property.id} is owned by 'system' and cannot be written by this caller`,
      { field: "relationPropertyId" },
      "owner_violation",
    );
  }
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
): Promise<RelationEdge> {
  const edgeContext = await loadRelationEdgeContext(client, input.relationPropertyId);
  await assertRelationDatabasesNotArchived(client, edgeContext);
  assertRelationPropertyWritable(edgeContext.property, context);
  await assertRelationEndpointsValid(client, edgeContext, input.callerItemId, input.targetItemId);

  const { itemA, itemB } = normalizeRelationSides(
    edgeContext.reldef,
    input.relationPropertyId,
    input.callerItemId,
    input.targetItemId,
  );
  const edge = await relationsStore.createItemRelation(client, {
    relationDefinitionId: edgeContext.reldef.id,
    itemA,
    itemB,
    metadata: input.metadata,
  });
  await enqueueRollupRecomputeForEdge(client, { relationDefinitionId: edgeContext.reldef.id, itemA, itemB });
  return edge;
}

/** The metadata-replacement counterpart to `createRelationWithClient`: requires an existing normalized edge (endpoints are immutable — moving one is delete plus create), and rejects a missing edge with a `404 not_found`. Same `context` contract as `createRelationWithClient`. */
export async function updateRelationWithClient(
  client: PoolClient,
  input: UpdateRelationInput,
  context?: SystemRelationWriteContext,
): Promise<RelationEdge> {
  const edgeContext = await loadRelationEdgeContext(client, input.relationPropertyId);
  await assertRelationDatabasesNotArchived(client, edgeContext);
  assertRelationPropertyWritable(edgeContext.property, context);
  await assertRelationEndpointsValid(client, edgeContext, input.callerItemId, input.targetItemId);

  const { itemA, itemB } = normalizeRelationSides(
    edgeContext.reldef,
    input.relationPropertyId,
    input.callerItemId,
    input.targetItemId,
  );
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
): Promise<RelationEdge | null> {
  const edgeContext = await loadRelationEdgeContext(client, input.relationPropertyId);
  await assertRelationDatabasesNotArchived(client, edgeContext);
  assertRelationPropertyWritable(edgeContext.property, context);
  const { itemA, itemB } = normalizeRelationSides(
    edgeContext.reldef,
    input.relationPropertyId,
    input.callerItemId,
    input.targetItemId,
  );
  const edge = await relationsStore.deleteItemRelation(client, edgeContext.reldef.id, itemA, itemB);
  await enqueueRollupRecomputeForEdge(client, { relationDefinitionId: edgeContext.reldef.id, itemA, itemB });
  return edge;
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
    async renameDatabase(id: string, name: string): Promise<DatabaseRow> {
      return withTransaction(pool, (client) => databasesStore.renameDatabase(client, id, name));
    },
    async getDatabase(id: string): Promise<DatabaseRow | null> {
      return withTransaction(pool, (client) => databasesStore.getDatabase(client, id));
    },
    /** Every non-archived database system-wide (issue #240's `GET /api/databases`) — see `databasesStore.listAllDatabases` for why this includes the ten system databases. */
    async listDatabases(): Promise<DatabaseRow[]> {
      return withTransaction(pool, (client) => databasesStore.listAllDatabases(client));
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

    /** Resolves a relation route's `:propertyKey` path segment (issue #157) — the choke-point's edge calls take a property id, never a key, so a REST caller must go through this first. */
    async getPropertyByKey(databaseId: string, key: string): Promise<PropertyRow | null> {
      return withTransaction(pool, (client) => propertiesStore.getPropertyByKey(client, databaseId, key));
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
      return withTransaction(pool, (client) => updatePropertyConfigWithClient(client, id, config));
    },

    async changePropertyType(id: string, newType: PropertyType): Promise<PropertyRow> {
      return withTransaction(pool, (client) => changePropertyTypeWithClient(client, id, newType));
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
    ): Promise<{ property: PropertyRow; typeChanged: boolean }> {
      return withTransaction(pool, async (client) => {
        let property = await propertiesStore.getProperty(client, id);
        if (!property) throw new NotFoundError(`Property ${id} not found`);

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
        return { property, typeChanged };
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
    /** Public facade: never passes a `SystemRelationWriteContext`, so an `owner: 'system'` side is always rejected (`owner_violation`). */
    async createRelationProperty(
      input: CreateRelationPropertyInput,
    ): Promise<{ property: PropertyRow; inverseProperty: PropertyRow | null }> {
      return withTransaction(pool, (client) =>
        createRelationPropertyWithClient(client, input, undefined, computedKeyRegistry),
      );
    },

    // ---- relations (data side: linking two items) ----
    async createRelation(input: CreateRelationInput): Promise<RelationEdge> {
      return withTransaction(pool, (client) => createRelationWithClient(client, input));
    },

    async updateRelation(input: UpdateRelationInput): Promise<RelationEdge> {
      return withTransaction(pool, (client) => updateRelationWithClient(client, input));
    },

    async deleteRelation(input: DeleteRelationInput): Promise<RelationEdge | null> {
      return withTransaction(pool, (client) => deleteRelationWithClient(client, input));
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

    /**
     * Cross-partition lookup by id alone (issue #241's `GET /api/items/:id`, whose URL carries no
     * `databaseId` to route `getItem`'s partitioned lookup through). Backed by the same
     * `getItemsByIds` scan `assertItemExists` already uses for view membership — acceptable here
     * for the same reason: a single-row point lookup, not a scan over a large membership list.
     */
    async findItem(itemId: string): Promise<ItemRow | null> {
      return withTransaction(pool, async (client) => {
        const [item] = await itemsStore.getItemsByIds(client, [itemId]);
        return item ?? null;
      });
    },

    /**
     * `findItem`'s counterpart that also resolves an already-trashed item — `DELETE
     * /api/items/:id` and `POST /api/items/:id/restore` (issue #156) both need an item's
     * `databaseId` before they can call `softDeleteItem`/`restoreItem`, and unlike `GET
     * /api/items/:id`, a trashed item is the expected target of either route, not a 404.
     */
    async findItemIncludingDeleted(itemId: string): Promise<ItemRow | null> {
      const [item] = await itemsStore.getItemsByIdsIncludingDeleted(pool, [itemId]);
      return item ?? null;
    },

    /**
     * The breadcrumb chain `GET /api/items/:id?include=path` needs (issue #241): starting at
     * `itemId`, walks `databases.parent_item_id` outward — from the item's own database to
     * whichever item (in whichever other database) that database is nested under, and that
     * item's own database's parent, and so on — so a caller never has to assemble hierarchy
     * itself. Ordered root-first, ending with `itemId`. Stops (rather than throwing) if an
     * ancestor's item or database has since gone missing partway up the chain; the caller
     * already has everything found below that point.
     *
     * Guards against a `parent_item_id` cycle (database A's parent item lives in a database
     * whose own parent item is, transitively, back in database A) by tracking every database
     * id already walked and stopping the moment one repeats — otherwise a cycle would hang this
     * loop, and the request, forever.
     *
     * Iterative per-level walk rather than a single recursive CTE — the trade-off is recorded in
     * `docs/adr/2026-09-11-iterative-parent-chain-traversal-in-choke-point.md`.
     */
    async getItemPath(itemId: string): Promise<ItemRow[]> {
      return withTransaction(pool, async (client) => {
        const chain: ItemRow[] = [];
        const visitedDatabaseIds = new Set<string>();
        let currentId: string | undefined = itemId;
        while (currentId) {
          const [item] = await itemsStore.getItemsByIds(client, [currentId]);
          if (!item) break;
          chain.unshift(item);
          if (visitedDatabaseIds.has(item.databaseId)) break;
          visitedDatabaseIds.add(item.databaseId);
          const database = await databasesStore.getDatabase(client, item.databaseId);
          currentId = database?.parentItemId ?? undefined;
        }
        return chain;
      });
    },

    /** Filter with either `filter` (a filter tree, views/filterTree.ts) or `buildFilterSql`, never both. */
    async listItems(databaseId: string, options?: ListItemsInput) {
      return withTransaction(pool, async (client) => {
        // `filter` is consumed by resolveFilterSql; `rest` is what the store itself takes.
        const { filter, ...rest } = options ?? {};
        const buildFilterSql = await resolveFilterSql(client, databaseId, {
          filter,
          buildFilterSql: rest.buildFilterSql,
        });
        return itemsStore.listItems(client, databaseId, { ...rest, buildFilterSql });
      });
    },

    /** The matching count for the same `filter` `listItems` takes — a count without paging the rows in. */
    async countItems(databaseId: string, options?: CountItemsInput): Promise<number> {
      return withTransaction(pool, async (client) => {
        const { filter, ...rest } = options ?? {};
        const buildFilterSql = await resolveFilterSql(client, databaseId, {
          filter,
          buildFilterSql: rest.buildFilterSql,
        });
        return itemsStore.countItems(client, databaseId, { ...rest, buildFilterSql });
      });
    },

    /**
     * Soft-deletes `itemId` and, in the same transaction, cascades to its whole subtree — every
     * inline database it owns and their rows, recursively (issue #156). Every database touched
     * anywhere in that subtree must be unarchived, or the entire cascade is rejected and nothing
     * is written; a database midway down the tree being archived is not a partial success.
     */
    async softDeleteItem(databaseId: string, itemId: string): Promise<ItemRow | null> {
      return withTransaction(pool, async (client) => {
        await assertDatabaseNotArchived(client, databaseId);
        // A system-module project (issue #24's Projects.systemActive) "can only be
        // deactivated, never deleted" — checked generically on `properties.systemActive`
        // rather than hardcoded to the Projects database, so any future database adopting
        // the same convention is covered too. Row-locked (not a plain getItemById): without
        // the lock, a concurrent updateItem setting systemActive: true could commit between
        // this read and the delete below, slipping a delete through on what was, by the time
        // it mattered, a system-active item. The lock is held until this transaction commits,
        // so a concurrent writer blocks here instead of racing past the check.
        const before = await itemsStore.lockItemById(client, databaseId, itemId);
        if (!before) return null;
        if (before.properties.systemActive === true) {
          throw new ForbiddenError(
            `Item ${itemId} is a system-active project and cannot be deleted, only deactivated`,
            { field: "systemActive" },
          );
        }
        if (before.deletedAt) return before; // already trashed: idempotent no-op, same as a repeat DELETE

        const subtree = await collectItemSubtree(client, before);
        for (const row of subtree) await assertDatabaseNotArchived(client, row.databaseId);

        let rootResult: ItemRow | null = null;
        for (const row of subtree) {
          const item = await itemsStore.softDeleteItem(client, row.databaseId, row.id);
          if (!item) continue; // already independently trashed: not part of this cascade, left untouched
          if (row.id === itemId) rootResult = item;
          await triggerOnItemEventHeartbeats(client, row.databaseId, "delete", row.id, queueAffinity);
          const edges = await relationsStore.listAllRelationsForItem(client, row.id);
          for (const edge of edges) await enqueueRollupRecomputeForEdge(client, edge);
        }
        return rootResult;
      });
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
    async restoreItem(databaseId: string, itemId: string): Promise<ItemRow | null> {
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

    // ---- views ----
    // An agent write here is a direct write, not a proposal through the `confirm` flow — see
    // [[2026-09-10-views-are-excluded-from-the-agent-proposal-flow]]. Issue #87 only tightens
    // *which* agent may write to *which* view, it does not introduce agent direct-writes.
    /**
     * `actor` (default `{ type: 'user' }`) governs `createdBy`/`creatorProjectItemId` — a
     * caller never sets either directly. Creating as `type: 'ai_agent'` requires and stores
     * `actor.agentProjectItemId` (issue #87); a 'user'/'system' actor stores no creator.
     */
    async createView(
      input: Omit<viewsStore.CreateViewInput, "createdBy" | "creatorProjectItemId">,
      actor: Actor = { type: "user" },
    ): Promise<ViewRow> {
      return withTransaction(pool, async (client) => {
        await assertAuthenticatedAgentIdentity(client, actor);
        return viewsStore.createView(
          client,
          {
            ...input,
            createdBy: actor.type,
            creatorProjectItemId: actor.type === "ai_agent" ? actor.agentProjectItemId! : null,
          },
          viewTypeRegistry,
        );
      });
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

    async patchView(input: {
      id: string;
      actor: Actor;
      name?: string;
      config?: Record<string, unknown>;
      isDefault?: boolean;
    }): Promise<ViewRow> {
      return withTransaction(pool, async (client) => {
        await assertAuthenticatedAgentIdentity(client, input.actor);
        const view = await viewsStore.getView(client, input.id);
        if (!view) throw new NotFoundError(`View ${input.id} not found`);
        assertViewWritable(view, input.actor);
        if (input.actor.type === "ai_agent" && input.isDefault !== undefined) {
          throw new ForbiddenError(
            "is_default cannot be set by an agent, not even on its own view",
            { field: "isDefault" },
            "owner_violation",
          );
        }
        // One-way adoption: a user's write to an agent's view flips it to 'user' and clears the
        // creator identity; a system view is never flipped by a user write.
        const adopt = input.actor.type === "user" && view.createdBy === "ai_agent";
        return viewsStore.patchView(
          client,
          input.id,
          {
            name: input.name,
            config: input.config,
            isDefault: input.isDefault,
            createdBy: adopt ? "user" : undefined,
            creatorProjectItemId: adopt ? null : undefined,
          },
          viewTypeRegistry,
        );
      });
    },

    async deleteView(input: { id: string; actor: Actor }): Promise<void> {
      return withTransaction(pool, async (client) => {
        await assertAuthenticatedAgentIdentity(client, input.actor);
        const view = await viewsStore.getView(client, input.id);
        if (!view) throw new NotFoundError(`View ${input.id} not found`);
        assertViewWritable(view, input.actor);
        await viewsStore.deleteView(client, input.id);
      });
    },

    // ---- view_items (curated view membership) ----
    async addViewItem(input: {
      viewId: string;
      itemId: string;
      position?: number;
      actor: Actor;
    }): Promise<ViewItemRow> {
      return withTransaction(pool, async (client) => {
        await assertAuthenticatedAgentIdentity(client, input.actor);
        const view = await viewsStore.getView(client, input.viewId);
        if (!view) throw new NotFoundError(`View ${input.viewId} not found`);
        if (view.databaseId !== null) {
          throw new ValidationError("Only a curated view (databaseId = null) accepts view_items membership", {
            field: "viewId",
          });
        }
        assertViewWritable(view, input.actor);
        await assertItemExists(client, input.itemId);
        await adoptIfUserWrite(client, view, input.actor, viewTypeRegistry);
        return viewItemsStore.addViewItem(client, input.viewId, input.itemId, input.position);
      });
    },

    async removeViewItem(input: { viewId: string; itemId: string; actor: Actor }): Promise<void> {
      return withTransaction(pool, async (client) => {
        await assertAuthenticatedAgentIdentity(client, input.actor);
        const view = await viewsStore.getView(client, input.viewId);
        if (!view) throw new NotFoundError(`View ${input.viewId} not found`);
        if (view.databaseId !== null) {
          throw new ValidationError("Only a curated view (databaseId = null) accepts view_items membership", {
            field: "viewId",
          });
        }
        assertViewWritable(view, input.actor);
        await adoptIfUserWrite(client, view, input.actor, viewTypeRegistry);
        const removed = await viewItemsStore.removeViewItem(client, input.viewId, input.itemId);
        if (!removed) throw new NotFoundError(`Item ${input.itemId} is not a member of view ${input.viewId}`);
      });
    },

    async reorderViewItem(input: {
      viewId: string;
      itemId: string;
      position: number;
      actor: Actor;
    }): Promise<ViewItemRow> {
      return withTransaction(pool, async (client) => {
        await assertAuthenticatedAgentIdentity(client, input.actor);
        const view = await viewsStore.getView(client, input.viewId);
        if (!view) throw new NotFoundError(`View ${input.viewId} not found`);
        assertViewWritable(view, input.actor);
        await adoptIfUserWrite(client, view, input.actor, viewTypeRegistry);
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

    /** `POST /api/databases/:id/query` (issue #157): raw, request-boundary-validated filter/sort/cursor/limit/inTrash. */
    async queryDatabaseItems(
      databaseId: string,
      input: viewQuery.DatabaseQueryInput,
    ): Promise<viewQuery.QueryViewResult> {
      return withTransaction(pool, (client) => viewQuery.queryDatabaseItems(client, databaseId, input));
    },

    /** `POST /api/views/:id/query` (issue #157): same raw request shape as `queryDatabaseItems`, resolved against a stored view. */
    async queryViewItems(viewId: string, input: viewQuery.ViewQueryInput): Promise<viewQuery.QueryViewResult> {
      return withTransaction(pool, (client) => viewQuery.queryViewItems(client, viewId, input));
    },
  };
}

async function applyRollupConfig(client: PoolClient, property: PropertyRow): Promise<void> {
  const sameDatabaseProperties = await propertiesStore.listPropertiesByDatabase(client, property.databaseId);
  const relationProperty = sameDatabaseProperties.find(
    (p) => p.key === (property.config as { relationPropertyKey?: string }).relationPropertyKey,
  );
  const targetDatabaseId = relationProperty
    ? (relationProperty.config as { targetDatabaseId?: string }).targetDatabaseId
    : undefined;
  const targetDatabaseProperties = targetDatabaseId
    ? await propertiesStore.listPropertiesByDatabase(client, targetDatabaseId)
    : [];

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
