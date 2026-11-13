// The choke point's own registries for a domain's transaction-scoped write side effects — a
// shared module in the sense of docs/adr/2026-09-24-choke-point-composed-from-domain-modules.md,
// owned by no domain. `itemWrites.ts`/`relationOps.ts` (and `itemTrash.ts` for the delete, restore and
// purge hooks) call `run*` inside the same transaction as the write itself; a domain module registers its
// hook through `../domainWriteHooks.ts`, the
// one composition point that knows every domain by name so `chokePoint/` does not have to.
// Constrained by: docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md
// and, for the initial relations in the create hook context,
// docs/adr/2026-11-12-create-hooks-are-given-the-initial-relations-of-their-create.md
// and, for the pre-write transform registry, docs/adr/2026-10-29-item-pre-write-transforms-per-module-registry.md
// and, for the delete and restore registries, docs/adr/2026-11-07-item-delete-and-restore-domain-hooks.md
// and docs/adr/2026-11-08-restore-hooks-carry-exact-deletion-epochs.md
// and, for the purge registry, docs/adr/2026-11-10-item-purge-domain-hooks.md
// and, for the update pre-lock registry, docs/adr/2026-11-12-an-update-takes-the-module-locks-before-it-locks-the-row.md
// and, for the delete and restore pre-lock registries,
// docs/adr/2026-11-12-deleting-a-calendar-takes-the-default-mark-lock-and-its-events-into-its-epoch.md
// and, for the delete approval guard registry,
// docs/adr/2026-11-11-a-mailboxes-item-is-trashed-only-by-the-system-writer.md
import type { PoolClient } from "pg";
import type { Item } from "@semprec/shared";
import type { DatabaseRow, ItemRow } from "../types.js";
import type { RelationEdgeContext } from "./relationEdgeContext.js";
import type { WriterIdentity, WriterKind } from "./writerKind.js";
import type { ActionQueueAffinity } from "../scheduler/actions.js";

/** One relation a create with initial relations names: a relation property and the items the new item is linked to through it. */
export interface ItemCreateInitialRelation {
  relationPropertyId: string;
  targetItemIds: readonly string[];
}

export interface ItemCreateHookContext {
  client: PoolClient;
  database: DatabaseRow;
  item: ItemRow;
  properties: Record<string, unknown>;
  /** The user id of a human REST writer; absent for every agent, `/mcp`, system and internal caller. */
  humanWriterUserId?: string;
  /** Who made the write; `system` when the caller supplied nothing. Sits next to `humanWriterUserId`, not instead of it. */
  writer: WriterIdentity;
  /**
   * The relations `createItemWithRelationsWithClient` (`itemCreateWithRelations.ts`) was given with this
   * create, without those whose property key its caller could not resolve. That function checks and writes
   * them on the same client after the create hooks returned, and throws when it cannot write one. When a
   * hook runs they are unchecked and the create has written none of their edges. Absent for a create
   * that function did not make. See
   * docs/adr/2026-11-12-create-hooks-are-given-the-initial-relations-of-their-create.md.
   */
  initialRelations?: readonly ItemCreateInitialRelation[];
}

export type ItemCreateHook = (context: ItemCreateHookContext) => Promise<void>;

export interface ItemUpdateHookContext {
  client: PoolClient;
  database: DatabaseRow;
  item: ItemRow;
  propertiesPatch: Record<string, unknown>;
  /** The user id of a human REST writer; absent for every agent, `/mcp`, system and internal caller. */
  humanWriterUserId?: string;
  /** Who made the write; `system` when the caller supplied nothing. Sits next to `humanWriterUserId`, not instead of it. */
  writer: WriterIdentity;
  /**
   * Set only by `convergeObservedEmailFlagsWithClient` (itemWrites.ts), mail sync's declared,
   * narrow ownership handoff for Emails' owner:'user' `read`/`flagged` properties — never by a
   * user-initiated write. See `UpdateItemWithClientOptions.skipMailDesiredStateRecording`'s doc
   * comment for why a provider observation must opt out of the Emails flag-sync hook.
   */
  skipMailDesiredStateRecording?: boolean;
}

export type ItemUpdateHook = (context: ItemUpdateHookContext) => Promise<void>;

/**
 * Context of an item update pre-lock hook: one update about to start, before it has locked or changed any row.
 * `patch` is the caller's patch as it was sent.
 */
export interface ItemUpdatePreLockHookContext {
  client: PoolClient;
  database: DatabaseRow;
  itemId: string;
  patch: Record<string, unknown>;
}

/**
 * Takes a lock that must be held before the update locks the written row, so every writer of a module orders
 * its locks the same way. It changes nothing and returns nothing; a throw rolls the update back. See
 * docs/adr/2026-11-12-an-update-takes-the-module-locks-before-it-locks-the-row.md.
 */
export type ItemUpdatePreLockHook = (context: ItemUpdatePreLockHookContext) => Promise<void>;

/**
 * Context of an item delete or restore pre-lock hook: one trash or restore about to start, before it has locked or
 * changed any row. `itemId` is the item the caller names, the root of the cascade.
 */
export interface ItemTrashPreLockHookContext {
  client: PoolClient;
  /** The database of the item the caller names. */
  database: DatabaseRow;
  itemId: string;
}

/**
 * Takes a lock that must be held before the trash cascade of `itemDeleteWithClient` locks the root row, so every
 * writer of a module orders its locks the same way. It changes nothing and returns nothing; a throw rolls the
 * delete back. It runs for the root the caller names only, never for a row the cascade reaches later. See
 * docs/adr/2026-11-12-deleting-a-calendar-takes-the-default-mark-lock-and-its-events-into-its-epoch.md.
 */
export type ItemDeletePreLockHook = (context: ItemTrashPreLockHookContext) => Promise<void>;

/** The restore counterpart of `ItemDeletePreLockHook`, run by `restoreItemWithClient` before it locks the root row. */
export type ItemRestorePreLockHook = (context: ItemTrashPreLockHookContext) => Promise<void>;

/**
 * Context of an item delete hook (issue #1601): one row the trash cascade of `itemDeleteWithClient`
 * actually soft-deleted in this call, never a row that was already in the trash.
 */
export interface ItemDeleteHookContext {
  client: PoolClient;
  /** The database of `item`. */
  database: DatabaseRow;
  /** The row after its soft delete. */
  item: ItemRow;
  /** The item the caller trashed, the root of the cascade; `item.id` for the root itself. */
  rootItemId: string;
  /** The `deletedAt` every row trashed by this cascade shares. */
  deletedAt: string;
  /** Who made the write; `system` when the caller supplied no writer. */
  writerKind: WriterKind;
  /** The agent run that made the write; set only for an agent writing under a run credential. */
  agentRunId?: string;
  /** The user whose request trashed the item, when there is one. */
  actingUserId?: string;
}

export type ItemDeleteHook = (context: ItemDeleteHookContext) => Promise<void>;

/**
 * Context of an item restore hook (issue #1601): one row `restoreItemWithClient` actually restored,
 * i.e. one trashed in the same cascade as the restored root.
 */
export interface ItemRestoreHookContext {
  client: PoolClient;
  /** The database of `item`. */
  database: DatabaseRow;
  /** The row after its restore. */
  item: ItemRow;
  /** The item the caller restored, the root of the cascade; `item.id` for the root itself. */
  rootItemId: string;
  /** The cascade's `deletedAt` that the restore cleared. */
  deletedAt: string;
  /**
   * The same epoch at the column's full precision, read by Postgres from the locked root before
   * anything was restored, as UTC text `YYYY-MM-DDTHH:MI:SS.ffffffZ` (always six fraction digits).
   * A hook compares it in SQL (`deleted_at = $1::timestamptz`), never through a JS `Date` or
   * `deletedAt`, which keep only milliseconds. See
   * docs/adr/2026-11-08-restore-hooks-carry-exact-deletion-epochs.md.
   */
  deletedAtExact: string;
  /** The queue routing the restoring caller writes with, for a hook that runs a nested choke-point write. */
  queueAffinity: ActionQueueAffinity;
  /** Who made the write; `system` when the caller supplied no writer. */
  writerKind: WriterKind;
  /** The agent run that made the write; set only for an agent writing under a run credential. */
  agentRunId?: string;
  /** The user whose request restored the item, when there is one. */
  actingUserId?: string;
}

export type ItemRestoreHook = (context: ItemRestoreHookContext) => Promise<void>;

/**
 * Context of an item purge hook: one row the permanent purge (`purgeExpiredTrashSubtree` in
 * `itemTrash.ts`) hard-deleted in this call, after that row's built-in dependents were deleted. See
 * docs/adr/2026-11-10-item-purge-domain-hooks.md.
 */
export interface ItemPurgeHookContext {
  /** The purge transaction's client, in the tenant scope the purge itself runs in. */
  client: PoolClient;
  /** The database of `item`. */
  database: DatabaseRow;
  /**
   * The removed row exactly as it was when the purge deleted it: read under a row lock in this
   * transaction immediately before the delete, so a write another transaction committed earlier is in
   * it and none could follow. A query through `client` no longer finds it.
   */
  item: ItemRow;
  /** The item this purge call was started for, the root of the purged subtree; `item.id` for the root itself. */
  rootItemId: string;
}

export type ItemPurgeHook = (context: ItemPurgeHookContext) => Promise<void>;

export interface RelationEdgeWriteHookContext {
  client: PoolClient;
  edgeContext: RelationEdgeContext;
  callerItemId: string;
  targetItemId: string;
  metadata?: Record<string, unknown>;
  /** Who made the write; `system` when the caller supplied nothing. */
  writer: WriterIdentity;
  lockMode?: "nowait";
  /**
   * Set by `createRelationIfAbsentWithClient` alone: the write inserts the edge when it is not stored and
   * leaves a stored edge as it is, metadata included.
   */
  insertOnly?: true;
}

export type RelationEdgeWriteHook = (context: RelationEdgeWriteHookContext) => Promise<void>;

/**
 * Context of a relation edge removal. A separate seam from `RelationEdgeWriteHookContext`: write hooks
 * validate edge metadata (Transcripts speakers) and must not run on a removal, so delete gets its own
 * registry.
 */
export interface RelationEdgeDeleteHookContext {
  client: PoolClient;
  edgeContext: RelationEdgeContext;
  callerItemId: string;
  targetItemId: string;
  /** Who removed the edge; `system` when the caller supplied nothing. */
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
 * Context of a pre-write transform: the properties a create or update is about to store. A transform runs
 * before the row is written, so it sees the locked current row in `stored` on update and `null` on create.
 */
export interface ItemPreWriteTransformContext {
  client: PoolClient;
  database: DatabaseRow;
  /** The locked current row on update; `null` on create. */
  stored: ItemRow | null;
  /** The properties the write would store. Each transform of the module receives the previous transform's output. */
  patch: Record<string, unknown>;
  /** The user id of a human REST writer; absent for every agent, `/mcp`, system and internal caller. */
  humanWriterUserId?: string;
  /** Who made the write; `system` when the caller supplied nothing. */
  writer: WriterIdentity;
}

/** Returns properties to store or throws. Real transforms run in the write transaction and may allocate values under their own locks; see [[2026-10-31-confirmed-proposal-update-preconditions]]. */
export type ItemPreWriteTransform = (context: ItemPreWriteTransformContext) => Promise<Record<string, unknown>>;

/**
 * What a read-only preparation receives. `timezone` is the tenant's IANA zone, read and validated by the
 * managed caller in its own tenant transaction and passed as a plain value; a preparation never reads the
 * setting itself.
 * See docs/adr/2026-11-07-proposal-preparation-uses-trusted-tenant-timezone.md.
 */
export interface ItemPreWritePreparationContext extends Pick<ItemPreWriteTransformContext, "stored" | "patch"> {
  timezone?: string;
}

/** A preparation cannot access a client or allocate server-assigned values. */
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
const activeChangedEdges = new WeakMap<PoolClient, Set<string>>();
/** Keyed by owning module id; each module's transforms keep their registration order. */
const itemPreWriteTransforms = new Map<string, ItemPreWriteTransform[]>();
/** Keyed by owning module id; each module's pre-lock hooks keep their registration order. */
const itemUpdatePreLockHooks = new Map<string, ItemUpdatePreLockHook[]>();
/** Keyed by owning module id; each module's delete pre-lock hooks keep their registration order. */
const itemDeletePreLockHooks = new Map<string, ItemDeletePreLockHook[]>();
/** Keyed by owning module id; each module's restore pre-lock hooks keep their registration order. */
const itemRestorePreLockHooks = new Map<string, ItemRestorePreLockHook[]>();
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
/** Context of an item delete approval guard: the live item an agent run asks to trash, and its database. */
export interface ItemDeleteApprovalGuardContext {
  client: PoolClient;
  /** The database of `item`; its `ownerModuleId` is the module the guard is registered for. */
  database: DatabaseRow;
  /** The item the request names, which is not in the trash. */
  item: ItemRow;
}

/**
 * A module's part of the approval projection of `item.delete` (`destructiveProjection.ts`): the
 * refusal a delete hook of the module answers an agent's trash of the item with, known before the
 * trash is attempted. It returns the message of that 403 `forbidden` error, or `null` when no hook of
 * the module refuses the trash. The projection runs before an agent run's request is stored and again
 * before an approved request is executed, so a trash that a hook can only refuse is never queued for
 * approval, and a request that was queued earlier ends as a conflict.
 *
 * A delete hook that refuses an agent's trash by a rule, and not by the state of this one attempt,
 * registers a guard with the same rule. The trash cascade runs its delete hooks only after the soft
 * delete, so the projection cannot run them itself.
 */
export type ItemDeleteApprovalGuard = (context: ItemDeleteApprovalGuardContext) => Promise<string | null>;
const itemDeleteApprovalGuards = new Map<string, ItemDeleteApprovalGuard>();
/** One guard per owning module; a second registration for the same module is refused. */
export function registerItemDeleteApprovalGuard(moduleId: string, guard: ItemDeleteApprovalGuard): void {
  if (itemDeleteApprovalGuards.has(moduleId)) throw new Error("Duplicate item delete approval guard");
  itemDeleteApprovalGuards.set(moduleId, guard);
}
export function getItemDeleteApprovalGuard(moduleId: string): ItemDeleteApprovalGuard | undefined {
  return itemDeleteApprovalGuards.get(moduleId);
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

/**
 * Attaches an update pre-lock hook to one owning module. The caller runs it only for a database whose
 * `ownerModuleId` is `moduleId`. Registering the same `(moduleId, hook)` twice is a no-op.
 */
export function registerItemUpdatePreLockHook(moduleId: string, hook: ItemUpdatePreLockHook): void {
  const registered = itemUpdatePreLockHooks.get(moduleId) ?? [];
  if (registered.includes(hook)) return;
  itemUpdatePreLockHooks.set(moduleId, [...registered, hook]);
}

/**
 * Attaches a delete pre-lock hook to one owning module. The caller runs it only for a database whose
 * `ownerModuleId` is `moduleId`. Registering the same `(moduleId, hook)` twice is a no-op.
 */
export function registerItemDeletePreLockHook(moduleId: string, hook: ItemDeletePreLockHook): void {
  const registered = itemDeletePreLockHooks.get(moduleId) ?? [];
  if (registered.includes(hook)) return;
  itemDeletePreLockHooks.set(moduleId, [...registered, hook]);
}

/** Attaches a restore pre-lock hook to one owning module; see `registerItemDeletePreLockHook`. */
export function registerItemRestorePreLockHook(moduleId: string, hook: ItemRestorePreLockHook): void {
  const registered = itemRestorePreLockHooks.get(moduleId) ?? [];
  if (registered.includes(hook)) return;
  itemRestorePreLockHooks.set(moduleId, [...registered, hook]);
}

/** Registering the same function twice is a no-op — a hook module imported from more than one place still runs once. */
export function registerItemUpdateHook(hook: ItemUpdateHook): void {
  itemUpdateHooks.add(hook);
}

/** Registering the same function twice is a no-op. See `runItemDeleteHooks` for when and how it runs. */
export function registerItemDeleteHook(hook: ItemDeleteHook): void {
  itemDeleteHooks.add(hook);
}

/** Registering the same function twice is a no-op. See `runItemRestoreHooks` for when and how it runs. */
export function registerItemRestoreHook(hook: ItemRestoreHook): void {
  itemRestoreHooks.add(hook);
}

/** Registering the same function twice is a no-op. See `runItemPurgeHooks` for when and how it runs. */
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

/**
 * Attaches a pre-write transform to one owning module. The caller runs it only for a database whose
 * `ownerModuleId` is `moduleId`. Registering the same `(moduleId, transform)` twice is a no-op.
 */
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

/** Whether a module has at least one pre-write transform; an update of a database without one takes no extra row lock. */
export function hasItemPreWriteTransform(moduleId: string): boolean {
  return itemPreWriteTransforms.has(moduleId);
}

/** Awaits every registered create hook sequentially inside the caller's transaction, after a real insert (never an idempotent replay) — the first rejection propagates and rolls the insert back. */
export async function runItemCreateHooks(context: ItemCreateHookContext): Promise<void> {
  for (const hook of itemCreateHooks) {
    await hook(context);
  }
}

/** Awaits every registered hook sequentially, in registration order, inside the caller's transaction — the first rejection propagates and rolls the write back exactly as a direct call did. */
export async function runItemUpdateHooks(context: ItemUpdateHookContext): Promise<void> {
  for (const hook of itemUpdateHooks) {
    await hook(context);
  }
}

/**
 * Awaits every registered delete hook sequentially, in registration order, inside the trash cascade's
 * transaction, after the row's soft delete. The first rejection propagates and rolls the whole cascade back.
 */
export async function runItemDeleteHooks(context: ItemDeleteHookContext): Promise<void> {
  for (const hook of itemDeleteHooks) {
    await hook(context);
  }
}

/**
 * Awaits every registered restore hook sequentially, in registration order, inside the restore cascade's
 * transaction, after the row's restore. The first rejection propagates and rolls the whole cascade back.
 */
export async function runItemRestoreHooks(context: ItemRestoreHookContext): Promise<void> {
  for (const hook of itemRestoreHooks) {
    await hook(context);
  }
}

/**
 * Awaits every registered purge hook sequentially, in registration order, inside the permanent purge's
 * transaction, after the row and its built-in dependents were deleted. The first rejection propagates
 * and rolls the purge of the whole subtree back.
 */
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

/** Awaits every registered edge-delete hook sequentially inside the caller's transaction, before the edge is removed. */
export async function runRelationEdgeDeleteHooks(context: RelationEdgeDeleteHookContext): Promise<void> {
  for (const hook of relationEdgeDeleteHooks) {
    await hook(context);
  }
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
 * Runs a module's pre-write transforms sequentially, in registration order, each receiving the previous
 * output, and returns the final patch. Returns `context.patch` unchanged when the module has none. The first
 * rejection propagates, so the caller's transaction rolls back before anything was stored.
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

/**
 * Runs a module's update pre-lock hooks sequentially, in registration order, inside the caller's transaction.
 * `updateItemWithClient` calls it before the first lock on the written row, and only for a module that has
 * one. The first rejection propagates and rolls the update back.
 */
export async function runItemUpdatePreLockHooks(
  moduleId: string,
  context: ItemUpdatePreLockHookContext,
): Promise<void> {
  for (const hook of itemUpdatePreLockHooks.get(moduleId) ?? []) {
    await hook(context);
  }
}

/**
 * Runs a module's delete pre-lock hooks sequentially, in registration order, inside the caller's transaction.
 * `itemDeleteWithClient` calls it before the first lock on the item it was asked to trash, and only for a module
 * that has one. The first rejection propagates and rolls the delete back.
 */
export async function runItemDeletePreLockHooks(moduleId: string, context: ItemTrashPreLockHookContext): Promise<void> {
  for (const hook of itemDeletePreLockHooks.get(moduleId) ?? []) {
    await hook(context);
  }
}

/**
 * Runs a module's restore pre-lock hooks sequentially, in registration order, inside the caller's transaction.
 * `restoreItemWithClient` calls it before the first lock on the item it was asked to restore, and only for a
 * module that has one. The first rejection propagates and rolls the restore back.
 */
export async function runItemRestorePreLockHooks(
  moduleId: string,
  context: ItemTrashPreLockHookContext,
): Promise<void> {
  for (const hook of itemRestorePreLockHooks.get(moduleId) ?? []) {
    await hook(context);
  }
}

/** Test-only reset of every registry — guarded so it cannot run against a real process's hooks. */
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
  itemReadProjections.clear();
  itemPreWriteTransforms.clear();
  itemUpdatePreLockHooks.clear();
  itemDeletePreLockHooks.clear();
  itemRestorePreLockHooks.clear();
  itemPreWritePreparations.clear();
  itemUpdateCommands.clear();
  itemPatchApprovalContributions.clear();
  itemDeleteApprovalGuards.clear();
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
