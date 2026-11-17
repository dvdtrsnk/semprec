// The choke point's registries for a domain's transaction-scoped write side effects, owned by no
// domain. `itemWrites.ts`, `relationOps.ts` and `itemTrash.ts` call `run*` inside the write's own
// transaction; domains register through `../domainWriteHooks.ts`, the one composition point that
// knows every domain by name. See
// docs/architecture/data-model-and-writes.md#write-time-registries-datachokepointhooksts.
import type { PoolClient } from "pg";
import type { Item } from "@semprec/shared";
import type { DatabaseRow, ItemRow } from "../types.js";
import type { RelationEdgeContext } from "./relationEdgeContext.js";
import type { WriterIdentity, WriterKind } from "./writerKind.js";
import type { ActionQueueAffinity } from "../scheduler/actions.js";
import type { DatabaseReader } from "../agentGrants/agentDatabaseAccess.js";

/** A relation property and the items the new item is linked to through it. */
export interface ItemCreateInitialRelation {
  relationPropertyId: string;
  targetItemIds: readonly string[];
}

export interface ItemCreateHookContext {
  client: PoolClient;
  database: DatabaseRow;
  item: ItemRow;
  properties: Record<string, unknown>;
  /**
   * Keys of `properties` filled from the property's `config.default` (named by neither the caller nor a
   * pre-write transform). A hook that decides by what the caller wrote ignores them.
   */
  defaultedKeys?: ReadonlySet<string>;
  /** Absent for every agent, `/mcp`, system and internal caller. */
  humanWriterUserId?: string;
  /** `system` when the caller supplied nothing. */
  writer: WriterIdentity;
  /**
   * The relations `createItemWithRelationsWithClient` was given, minus unresolvable keys. They are
   * checked and written after the create hooks return, so a hook sees them unchecked and unwritten.
   * Absent for any other create.
   */
  initialRelations?: readonly ItemCreateInitialRelation[];
}

export type ItemCreateHook = (context: ItemCreateHookContext) => Promise<void>;

export interface ItemUpdateHookContext {
  client: PoolClient;
  database: DatabaseRow;
  item: ItemRow;
  propertiesPatch: Record<string, unknown>;
  /**
   * For every key of the patch, the value stored before this write (`null` when none). Absent means
   * unknown, and a hook then treats every patched key as changed.
   */
  previous?: Readonly<Record<string, unknown>>;
  /** Absent for every agent, `/mcp`, system and internal caller. */
  humanWriterUserId?: string;
  /** `system` when the caller supplied nothing. */
  writer: WriterIdentity;
  /**
   * Set only by `convergeObservedEmailFlagsWithClient`, mail sync's ownership handoff for Emails'
   * `read`/`flagged`: a provider observation must not be recorded back as desired state.
   */
  skipMailDesiredStateRecording?: boolean;
}

export type ItemUpdateHook = (context: ItemUpdateHookContext) => Promise<void>;

/** One update about to start, before it has locked or changed any row; `patch` is as the caller sent it. */
export interface ItemUpdatePreLockHookContext {
  client: PoolClient;
  database: DatabaseRow;
  itemId: string;
  patch: Record<string, unknown>;
}

/**
 * Takes a lock that must be held before the update locks the written row, so every writer of a
 * module orders its locks alike. Changes nothing; a throw rolls the update back.
 */
export type ItemUpdatePreLockHook = (context: ItemUpdatePreLockHookContext) => Promise<void>;

/** One trash, restore or purge about to start, before any row is locked; `itemId` is the cascade root. */
export interface ItemTrashPreLockHookContext {
  client: PoolClient;
  database: DatabaseRow;
  itemId: string;
}

/**
 * Takes a lock that must be held before the trash cascade locks the root row, so every writer of a
 * module orders its locks alike. Runs for the root only. Changes nothing; a throw rolls back.
 */
export type ItemDeletePreLockHook = (context: ItemTrashPreLockHookContext) => Promise<void>;

/** Run by `restoreItemWithClient` before it locks the root row. */
export type ItemRestorePreLockHook = (context: ItemTrashPreLockHookContext) => Promise<void>;

/** Run by `purgeExpiredTrashSubtree` before it walks the cascade, so a purge locks in the order trash and restore do. */
export type ItemPurgePreLockHook = (context: ItemTrashPreLockHookContext) => Promise<void>;

/** One row the trash cascade actually soft-deleted in this call, never one already in the trash. */
export interface ItemDeleteHookContext {
  client: PoolClient;
  database: DatabaseRow;
  item: ItemRow;
  /** The cascade root; `item.id` for the root itself. */
  rootItemId: string;
  /** Shared by every row this cascade trashed. */
  deletedAt: string;
  writerKind: WriterKind;
  agentRunId?: string;
  actingUserId?: string;
}

export type ItemDeleteHook = (context: ItemDeleteHookContext) => Promise<void>;

/** One row restored in the same cascade as the restored root. */
export interface ItemRestoreHookContext {
  client: PoolClient;
  database: DatabaseRow;
  item: ItemRow;
  /** The cascade root; `item.id` for the root itself. */
  rootItemId: string;
  deletedAt: string;
  /**
   * The epoch at full precision as UTC text `YYYY-MM-DDTHH:MI:SS.ffffffZ`, read from the locked root
   * before anything was restored. Compare it in SQL (`deleted_at = $1::timestamptz`), never through a
   * JS `Date` or `deletedAt`, which keep only milliseconds.
   */
  deletedAtExact: string;
  /** For a hook that runs a nested choke-point write. */
  queueAffinity: ActionQueueAffinity;
  writerKind: WriterKind;
  agentRunId?: string;
  actingUserId?: string;
}

export type ItemRestoreHook = (context: ItemRestoreHookContext) => Promise<void>;

/** One row the permanent purge hard-deleted in this call, after its built-in dependents. */
export interface ItemPurgeHookContext {
  /** In the purge's own tenant scope. */
  client: PoolClient;
  database: DatabaseRow;
  /**
   * The row as read under lock immediately before the delete, so no other write can follow it. A query
   * through `client` no longer finds it.
   */
  item: ItemRow;
  /** The root of the purged subtree; `item.id` for the root itself. */
  rootItemId: string;
}

export type ItemPurgeHook = (context: ItemPurgeHookContext) => Promise<void>;

export interface RelationEdgeWriteHookContext {
  client: PoolClient;
  edgeContext: RelationEdgeContext;
  callerItemId: string;
  targetItemId: string;
  metadata?: Record<string, unknown>;
  /** `system` when the caller supplied nothing. */
  writer: WriterIdentity;
  lockMode?: "nowait";
  /** Set by `createRelationIfAbsentWithClient` alone: a stored edge is left as it is, metadata included. */
  insertOnly?: true;
}

export type RelationEdgeWriteHook = (context: RelationEdgeWriteHookContext) => Promise<void>;

/** Separate from write hooks, which validate edge metadata and must not run on a removal. */
export interface RelationEdgeDeleteHookContext {
  client: PoolClient;
  edgeContext: RelationEdgeContext;
  callerItemId: string;
  targetItemId: string;
  /** `system` when the caller supplied nothing. */
  writer: WriterIdentity;
  lockMode?: "nowait";
}

export type RelationEdgeDeleteHook = (context: RelationEdgeDeleteHookContext) => Promise<void>;

export interface RelationEdgeChangedHookContext {
  client: PoolClient;
  op: "create" | "update" | "delete";
  relationDefinitionId: string;
  propertyId: string;
  itemA: string;
  itemB: string;
  metadata: Record<string, unknown>;
  writer: WriterIdentity;
}

export type RelationEdgeChangedHook = (context: RelationEdgeChangedHookContext) => Promise<void>;

/**
 * Runs once for an edge a user or agent wrote, right after the edge row changed and before the write
 * locks any value link row. Takes the locks that must precede those rows and writes nothing. `op` is
 * `create` or `delete`. See docs/architecture/transactions-and-side-effects.md#mandatory-lock-orders.
 */
export type RelationEdgeBeforeLinkBreakHook = (context: RelationEdgeChangedHookContext) => Promise<void>;

/** The properties a create or update is about to store, before the row is written. */
export interface ItemPreWriteTransformContext {
  client: PoolClient;
  database: DatabaseRow;
  stored: ItemRow | null;
  /** Each transform of the module receives the previous transform's output. */
  patch: Record<string, unknown>;
  /** Absent for every agent, `/mcp`, system and internal caller. */
  humanWriterUserId?: string;
  /** `system` when the caller supplied nothing. */
  writer: WriterIdentity;
}

/** Returns properties to store or throws. Runs in the write transaction and may allocate values under its own locks. */
export type ItemPreWriteTransform = (context: ItemPreWriteTransformContext) => Promise<Record<string, unknown>>;

/**
 * `timezone` is the tenant's IANA zone, validated by the managed caller in its own tenant transaction;
 * a preparation never reads the setting itself.
 */
export interface ItemPreWritePreparationContext extends Pick<ItemPreWriteTransformContext, "stored" | "patch"> {
  timezone?: string;
}

export type ItemPreWritePreparation = (context: ItemPreWritePreparationContext) => Promise<{
  patch: Record<string, unknown>;
  deferredKeys: string[];
}>;

const itemCreateHooks = new Set<ItemCreateHook>();
const itemUpdateHooks = new Set<ItemUpdateHook>();
const itemDeleteHooks = new Set<ItemDeleteHook>();
const itemRestoreHooks = new Set<ItemRestoreHook>();
const itemPurgeHooks = new Set<ItemPurgeHook>();
const relationEdgeWriteHooks = new Set<RelationEdgeWriteHook>();
const relationEdgeDeleteHooks = new Set<RelationEdgeDeleteHook>();
const relationEdgeChangedHooks = new Set<RelationEdgeChangedHook>();
const relationEdgeBeforeLinkBreakHooks = new Set<RelationEdgeBeforeLinkBreakHook>();
const activeChangedEdges = new WeakMap<PoolClient, Set<string>>();
/** Keyed by owning module id, in registration order (as the maps below). */
const itemPreWriteTransforms = new Map<string, ItemPreWriteTransform[]>();
const itemUpdatePreLockHooks = new Map<string, ItemUpdatePreLockHook[]>();
const itemDeletePreLockHooks = new Map<string, ItemDeletePreLockHook[]>();
const itemRestorePreLockHooks = new Map<string, ItemRestorePreLockHook[]>();
const itemPurgePreLockHooks = new Map<string, ItemPurgePreLockHook[]>();
const itemPreWritePreparations = new Map<string, Map<ItemPreWriteTransform, ItemPreWritePreparation>>();

export interface ItemUpdateCommand {
  key: string;
  transform: ItemPreWriteTransform;
  consume: (context: ItemPreWriteTransformContext, value: unknown) => Promise<Record<string, unknown>>;
  validate: (value: unknown) => void;
  prepare: (
    value: unknown,
    stored: ItemRow,
    patch: Record<string, unknown>,
  ) => {
    intent: unknown;
    preconditions: Record<string, unknown>;
  };
}
export type ItemPatchApprovalContribution = (
  client: PoolClient,
  item: ItemRow,
  patch: Record<string, unknown>,
) => Promise<{
  snapshot: unknown;
  description: { key: string; params: Record<string, string | null> };
} | null>;
const itemPatchApprovalContributions = new Map<string, ItemPatchApprovalContribution>();
export function registerItemPatchApprovalContribution(
  moduleId: string,
  contribution: ItemPatchApprovalContribution,
): void {
  if (itemPatchApprovalContributions.has(moduleId)) throw new Error("Duplicate item approval contribution");
  itemPatchApprovalContributions.set(moduleId, contribution);
}
export function getItemPatchApprovalContribution(moduleId: string): ItemPatchApprovalContribution | undefined {
  return itemPatchApprovalContributions.get(moduleId);
}
export interface ItemDeleteApprovalGuardContext {
  client: PoolClient;
  /** Its `ownerModuleId` is the module the guard is registered for. */
  database: DatabaseRow;
  /** Not in the trash. */
  item: ItemRow;
}

/**
 * A module's part of the `item.delete` approval projection: the 403 `forbidden` message a delete hook
 * would answer an agent's trash with, or `null`. The projection runs before a request is stored and
 * again before execution, so a trash a hook can only refuse is never queued, and a queued one ends as
 * a conflict. A delete hook that refuses by rule (not by this attempt's state) registers a matching
 * guard, since the hooks run only after the soft delete.
 */
export type ItemDeleteApprovalGuard = (context: ItemDeleteApprovalGuardContext) => Promise<string | null>;
const itemDeleteApprovalGuards = new Map<string, ItemDeleteApprovalGuard>();
/** One per owning module; a second registration is refused. */
export function registerItemDeleteApprovalGuard(moduleId: string, guard: ItemDeleteApprovalGuard): void {
  if (itemDeleteApprovalGuards.has(moduleId)) throw new Error("Duplicate item delete approval guard");
  itemDeleteApprovalGuards.set(moduleId, guard);
}
export function getItemDeleteApprovalGuard(moduleId: string): ItemDeleteApprovalGuard | undefined {
  return itemDeleteApprovalGuards.get(moduleId);
}
export interface ItemCascadeExpansionContext {
  client: PoolClient;
  /** Its `ownerModuleId` is the module the expansion is registered for. */
  database: DatabaseRow;
  /** As the caller read it. */
  root: ItemRow;
}

/**
 * Extra rows, besides the root and its inline databases' items, a module trashes and restores with
 * the root. Returns them in any state, without the root, and changes nothing; the cascade then applies
 * its own rules (delete skips trashed rows, restore takes the root's epoch, purge takes rows past the
 * cutoff).
 */
export type ItemCascadeExpansion = (context: ItemCascadeExpansionContext) => Promise<ItemRow[]>;
const itemCascadeExpansions = new Map<string, ItemCascadeExpansion>();
/** One per owning module; a second registration is refused. */
export function registerItemCascadeExpansion(moduleId: string, expansion: ItemCascadeExpansion): void {
  if (itemCascadeExpansions.has(moduleId)) throw new Error("Duplicate item cascade expansion");
  itemCascadeExpansions.set(moduleId, expansion);
}
export function getItemCascadeExpansion(moduleId: string): ItemCascadeExpansion | undefined {
  return itemCascadeExpansions.get(moduleId);
}

/**
 * What deleting an item reaches beyond its cascade, for the delete confirmation: live instances of
 * its recurring series, live attachments and live host events it has edges to.
 */
export interface ItemDeleteImpact {
  seriesInstanceCount: number;
  attachmentCount: number;
  hostEventCount: number;
}

export interface ItemDeleteImpactContext {
  client: PoolClient;
  /** Its `ownerModuleId` is the module the reader is registered for. */
  database: DatabaseRow;
  item: ItemRow;
  /**
   * An agent's project or an external client; nothing it may not read is counted, so no count discloses
   * a hidden item. Absent for a person and the system.
   */
  reader?: DatabaseReader;
}

/**
 * Read by both the delete preview and the `item.delete` approval projection, so the snapshot covers
 * the numbers the confirmation showed. Changes nothing.
 */
export type ItemDeleteImpactReader = (context: ItemDeleteImpactContext) => Promise<ItemDeleteImpact>;
const itemDeleteImpactReaders = new Map<string, ItemDeleteImpactReader>();
/** One per owning module; a second registration is refused. */
export function registerItemDeleteImpactReader(moduleId: string, reader: ItemDeleteImpactReader): void {
  if (itemDeleteImpactReaders.has(moduleId)) throw new Error("Duplicate item delete impact reader");
  itemDeleteImpactReaders.set(moduleId, reader);
}

/** `null` when the database has no owner module or the module has no reader. */
export async function readItemDeleteImpact(context: ItemDeleteImpactContext): Promise<ItemDeleteImpact | null> {
  const moduleId = context.database.ownerModuleId;
  const reader = moduleId === null ? undefined : itemDeleteImpactReaders.get(moduleId);
  return reader ? reader(context) : null;
}
const itemUpdateCommands = new Map<string, ItemUpdateCommand>();
export function registerItemUpdateCommand(moduleId: string, command: ItemUpdateCommand): void {
  if (itemUpdateCommands.has(moduleId)) throw new Error("Duplicate item update command");
  itemUpdateCommands.set(moduleId, command);
}
export function getItemUpdateCommand(moduleId: string): ItemUpdateCommand | undefined {
  return itemUpdateCommands.get(moduleId);
}
export function isItemUpdateCommandPaired(moduleId: string, command: ItemUpdateCommand): boolean {
  return (
    (itemPreWriteTransforms.get(moduleId)?.includes(command.transform) ?? false) &&
    (itemPreWritePreparations.get(moduleId)?.has(command.transform) ?? false)
  );
}

export function registerItemCreateHook(hook: ItemCreateHook): void {
  itemCreateHooks.add(hook);
}

/** Runs only for databases whose `ownerModuleId` is `moduleId`. Re-registering the same pair is a no-op. */
export function registerItemUpdatePreLockHook(moduleId: string, hook: ItemUpdatePreLockHook): void {
  const registered = itemUpdatePreLockHooks.get(moduleId) ?? [];
  if (registered.includes(hook)) return;
  itemUpdatePreLockHooks.set(moduleId, [...registered, hook]);
}

/** Runs only for databases whose `ownerModuleId` is `moduleId`. Re-registering the same pair is a no-op. */
export function registerItemDeletePreLockHook(moduleId: string, hook: ItemDeletePreLockHook): void {
  const registered = itemDeletePreLockHooks.get(moduleId) ?? [];
  if (registered.includes(hook)) return;
  itemDeletePreLockHooks.set(moduleId, [...registered, hook]);
}

/** See `registerItemDeletePreLockHook`. */
export function registerItemRestorePreLockHook(moduleId: string, hook: ItemRestorePreLockHook): void {
  const registered = itemRestorePreLockHooks.get(moduleId) ?? [];
  if (registered.includes(hook)) return;
  itemRestorePreLockHooks.set(moduleId, [...registered, hook]);
}

/** See `registerItemDeletePreLockHook`. */
export function registerItemPurgePreLockHook(moduleId: string, hook: ItemPurgePreLockHook): void {
  const registered = itemPurgePreLockHooks.get(moduleId) ?? [];
  if (registered.includes(hook)) return;
  itemPurgePreLockHooks.set(moduleId, [...registered, hook]);
}

/** Re-registering the same function is a no-op, so a hook module imported twice still runs once. */
export function registerItemUpdateHook(hook: ItemUpdateHook): void {
  itemUpdateHooks.add(hook);
}

/** Re-registering the same function is a no-op. */
export function registerItemDeleteHook(hook: ItemDeleteHook): void {
  itemDeleteHooks.add(hook);
}

/** Re-registering the same function is a no-op. */
export function registerItemRestoreHook(hook: ItemRestoreHook): void {
  itemRestoreHooks.add(hook);
}

/** Re-registering the same function is a no-op. */
export function registerItemPurgeHook(hook: ItemPurgeHook): void {
  itemPurgeHooks.add(hook);
}

export function registerRelationEdgeWriteHook(hook: RelationEdgeWriteHook): void {
  relationEdgeWriteHooks.add(hook);
}

export function registerRelationEdgeDeleteHook(hook: RelationEdgeDeleteHook): void {
  relationEdgeDeleteHooks.add(hook);
}

export function registerRelationEdgeChangedHook(hook: RelationEdgeChangedHook): void {
  relationEdgeChangedHooks.add(hook);
}

/** Re-registering the same function is a no-op. */
export function registerRelationEdgeBeforeLinkBreakHook(hook: RelationEdgeBeforeLinkBreakHook): void {
  relationEdgeBeforeLinkBreakHooks.add(hook);
}

/** Runs only for databases whose `ownerModuleId` is `moduleId`. Re-registering the same pair is a no-op. */
export function registerItemPreWriteTransform(
  moduleId: string,
  transform: ItemPreWriteTransform,
  prepare?: ItemPreWritePreparation,
): void {
  const registered = itemPreWriteTransforms.get(moduleId) ?? [];
  if (registered.includes(transform)) return;
  itemPreWriteTransforms.set(moduleId, [...registered, transform]);
  if (prepare) {
    const preparations =
      itemPreWritePreparations.get(moduleId) ?? new Map<ItemPreWriteTransform, ItemPreWritePreparation>();
    preparations.set(transform, prepare);
    itemPreWritePreparations.set(moduleId, preparations);
  }
}

/** Returns null when any registered transform cannot safely be prepared. */
export async function prepareItemPreWriteTransforms(
  moduleId: string,
  context: ItemPreWritePreparationContext,
): Promise<{ patch: Record<string, unknown>; deferredKeys: string[] } | null> {
  let patch = context.patch;
  const deferredKeys: string[] = [];
  for (const transform of itemPreWriteTransforms.get(moduleId) ?? []) {
    const prepare = itemPreWritePreparations.get(moduleId)?.get(transform);
    if (!prepare || deferredKeys.length > 0) return null;
    const result = await prepare({ ...context, patch });
    patch = result.patch;
    deferredKeys.push(...result.deferredKeys);
  }
  return { patch, deferredKeys };
}

/** An update of a database without one takes no extra row lock. */
export function hasItemPreWriteTransform(moduleId: string): boolean {
  return itemPreWriteTransforms.has(moduleId);
}

/** Sequentially in the caller's transaction, after a real insert (never an idempotent replay); the first rejection rolls the insert back. */
export async function runItemCreateHooks(context: ItemCreateHookContext): Promise<void> {
  for (const hook of itemCreateHooks) {
    await hook(context);
  }
}

/** Sequentially in registration order in the caller's transaction; the first rejection rolls the write back. */
export async function runItemUpdateHooks(context: ItemUpdateHookContext): Promise<void> {
  for (const hook of itemUpdateHooks) {
    await hook(context);
  }
}

/** In the cascade's transaction after the row's soft delete; the first rejection rolls the whole cascade back. */
export async function runItemDeleteHooks(context: ItemDeleteHookContext): Promise<void> {
  for (const hook of itemDeleteHooks) {
    await hook(context);
  }
}

/** In the cascade's transaction after the row's restore; the first rejection rolls the whole cascade back. */
export async function runItemRestoreHooks(context: ItemRestoreHookContext): Promise<void> {
  for (const hook of itemRestoreHooks) {
    await hook(context);
  }
}

/** In the purge's transaction after the row and its dependents are deleted; the first rejection rolls back the whole subtree's purge. */
export async function runItemPurgeHooks(context: ItemPurgeHookContext): Promise<void> {
  for (const hook of itemPurgeHooks) {
    await hook(context);
  }
}

export async function runRelationEdgeWriteHooks(context: RelationEdgeWriteHookContext): Promise<void> {
  for (const hook of relationEdgeWriteHooks) {
    await hook(context);
  }
}

/** In the caller's transaction, before the edge is removed. */
export async function runRelationEdgeDeleteHooks(context: RelationEdgeDeleteHookContext): Promise<void> {
  for (const hook of relationEdgeDeleteHooks) {
    await hook(context);
  }
}

/**
 * Called by the relation create/delete writes for a user or agent write, after the edge row changed
 * and before the agent approval check and the link break lock a value link row. A throw ends the write.
 */
export async function runRelationEdgeBeforeLinkBreakHooks(context: RelationEdgeChangedHookContext): Promise<void> {
  for (const hook of relationEdgeBeforeLinkBreakHooks) await hook(context);
}

export async function runRelationEdgeChangedHooks(context: RelationEdgeChangedHookContext): Promise<void> {
  const key = JSON.stringify([context.relationDefinitionId, context.itemA, context.itemB]);
  const active = activeChangedEdges.get(context.client) ?? new Set<string>();
  if (active.has(key)) throw new Error(`Recursive relation edge change: ${key}`);
  activeChangedEdges.set(context.client, active);
  active.add(key);
  try {
    for (const hook of relationEdgeChangedHooks) await hook(context);
  } finally {
    active.delete(key);
    if (active.size === 0) activeChangedEdges.delete(context.client);
  }
}

/**
 * Each transform receives the previous output; returns the final patch (`context.patch` when none).
 * A rejection rolls back before anything is stored.
 */
export async function runItemPreWriteTransforms(
  moduleId: string,
  context: ItemPreWriteTransformContext,
): Promise<Record<string, unknown>> {
  let patch = context.patch;
  for (const transform of itemPreWriteTransforms.get(moduleId) ?? []) {
    patch = await transform({ ...context, patch });
  }
  return patch;
}

/** Called by `updateItemWithClient` before the first lock on the written row. A rejection rolls back. */
export async function runItemUpdatePreLockHooks(
  moduleId: string,
  context: ItemUpdatePreLockHookContext,
): Promise<void> {
  for (const hook of itemUpdatePreLockHooks.get(moduleId) ?? []) {
    await hook(context);
  }
}

/** Called by `itemDeleteWithClient` before the first lock on the root. A rejection rolls back. */
export async function runItemDeletePreLockHooks(moduleId: string, context: ItemTrashPreLockHookContext): Promise<void> {
  for (const hook of itemDeletePreLockHooks.get(moduleId) ?? []) {
    await hook(context);
  }
}

/** Called by `restoreItemWithClient` before the first lock on the root. A rejection rolls back. */
export async function runItemRestorePreLockHooks(
  moduleId: string,
  context: ItemTrashPreLockHookContext,
): Promise<void> {
  for (const hook of itemRestorePreLockHooks.get(moduleId) ?? []) {
    await hook(context);
  }
}

/** Called by `purgeExpiredTrashSubtree` after the root proved eligible and before any row lock. A rejection rolls back. */
export async function runItemPurgePreLockHooks(moduleId: string, context: ItemTrashPreLockHookContext): Promise<void> {
  for (const hook of itemPurgePreLockHooks.get(moduleId) ?? []) {
    await hook(context);
  }
}

/** Guarded so it cannot run against a real process's hooks. */
export function clearHooksForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("clearHooksForTests() must only be called in tests");
  }
  itemCreateHooks.clear();
  itemUpdateHooks.clear();
  itemDeleteHooks.clear();
  itemRestoreHooks.clear();
  itemPurgeHooks.clear();
  relationEdgeWriteHooks.clear();
  relationEdgeDeleteHooks.clear();
  relationEdgeChangedHooks.clear();
  relationEdgeBeforeLinkBreakHooks.clear();
  itemReadProjections.clear();
  itemPreWriteTransforms.clear();
  itemUpdatePreLockHooks.clear();
  itemDeletePreLockHooks.clear();
  itemRestorePreLockHooks.clear();
  itemPurgePreLockHooks.clear();
  itemPreWritePreparations.clear();
  itemUpdateCommands.clear();
  itemPatchApprovalContributions.clear();
  itemDeleteApprovalGuards.clear();
  itemCascadeExpansions.clear();
  itemDeleteImpactReaders.clear();
  automationBatchReader = undefined;
}

type AutomationBatchReader = (
  client: PoolClient,
  itemIds: string[],
) => Promise<Map<string, NonNullable<Item["automation"]>>>;
let automationBatchReader: AutomationBatchReader | undefined;

export function registerAutomationBatchReader(reader: AutomationBatchReader): void {
  if (automationBatchReader && automationBatchReader !== reader)
    throw new Error("Automation batch reader is already registered");
  automationBatchReader = reader;
}

export function runAutomationBatchReader(
  client: PoolClient,
  itemIds: string[],
): Promise<Map<string, NonNullable<Item["automation"]>>> {
  if (!automationBatchReader) throw new Error("Automation batch reader is not registered");
  return automationBatchReader(client, itemIds);
}

export interface ItemReadProjection {
  ownerModuleId: string;
  project: (item: ItemRow) => ItemRow;
}
const itemReadProjections = new Map<string, ItemReadProjection>();

export function registerItemReadProjection(projection: ItemReadProjection): void {
  itemReadProjections.set(projection.ownerModuleId, projection);
}

export function projectItemForRead<T extends ItemRow>(item: T, ownerModuleId: string | null): T {
  const projection = ownerModuleId === null ? undefined : itemReadProjections.get(ownerModuleId);
  return projection ? { ...item, ...projection.project(item) } : item;
}
