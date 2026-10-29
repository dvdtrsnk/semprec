// The choke point's own registries for a domain's transaction-scoped write side effects — a
// shared module in the sense of docs/adr/2026-09-24-choke-point-composed-from-domain-modules.md,
// owned by no domain. `itemWrites.ts`/`relationOps.ts` call `run*` inside the same transaction
// as the write itself; a domain module registers its hook through `../domainWriteHooks.ts`, the
// one composition point that knows every domain by name so `chokePoint/` does not have to.
// Constrained by: docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md
// and, for the pre-write transform registry, docs/adr/2026-10-29-item-pre-write-transforms-per-module-registry.md
import type { PoolClient } from "pg";
import type { DatabaseRow, ItemRow } from "../types.js";
import type { RelationEdgeContext } from "./relationEdgeContext.js";
import type { WriterIdentity } from "./writerKind.js";

export interface ItemCreateHookContext {
  client: PoolClient;
  database: DatabaseRow;
  item: ItemRow;
  properties: Record<string, unknown>;
  /** The user id of a human REST writer; absent for every agent, `/mcp`, system and internal caller. */
  humanWriterUserId?: string;
  /** Who made the write; `system` when the caller supplied nothing. Sits next to `humanWriterUserId`, not instead of it. */
  writer: WriterIdentity;
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

export interface RelationEdgeWriteHookContext {
  client: PoolClient;
  edgeContext: RelationEdgeContext;
  callerItemId: string;
  targetItemId: string;
  metadata?: Record<string, unknown>;
  /** Who made the write; `system` when the caller supplied nothing. */
  writer: WriterIdentity;
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
}

export type RelationEdgeDeleteHook = (context: RelationEdgeDeleteHookContext) => Promise<void>;

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

/** Returns the properties to store, or throws (`ValidationError` for a rejected value). Must be deterministic: a create replay runs it and discards the result. */
export type ItemPreWriteTransform = (context: ItemPreWriteTransformContext) => Promise<Record<string, unknown>>;

const itemCreateHooks = new Set<ItemCreateHook>();
const itemUpdateHooks = new Set<ItemUpdateHook>();
const relationEdgeWriteHooks = new Set<RelationEdgeWriteHook>();
const relationEdgeDeleteHooks = new Set<RelationEdgeDeleteHook>();
/** Keyed by owning module id; each module's transforms keep their registration order. */
const itemPreWriteTransforms = new Map<string, ItemPreWriteTransform[]>();

export function registerItemCreateHook(hook: ItemCreateHook): void {
  itemCreateHooks.add(hook);
}

/** Registering the same function twice is a no-op — a hook module imported from more than one place still runs once. */
export function registerItemUpdateHook(hook: ItemUpdateHook): void {
  itemUpdateHooks.add(hook);
}

export function registerRelationEdgeWriteHook(hook: RelationEdgeWriteHook): void {
  relationEdgeWriteHooks.add(hook);
}

export function registerRelationEdgeDeleteHook(hook: RelationEdgeDeleteHook): void {
  relationEdgeDeleteHooks.add(hook);
}

/**
 * Attaches a pre-write transform to one owning module. The caller runs it only for a database whose
 * `ownerModuleId` is `moduleId`. Registering the same `(moduleId, transform)` twice is a no-op.
 */
export function registerItemPreWriteTransform(moduleId: string, transform: ItemPreWriteTransform): void {
  const registered = itemPreWriteTransforms.get(moduleId) ?? [];
  if (registered.includes(transform)) return;
  itemPreWriteTransforms.set(moduleId, [...registered, transform]);
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

/** Test-only reset of every registry — guarded so it cannot run against a real process's hooks. */
export function clearHooksForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("clearHooksForTests() must only be called in tests");
  }
  itemCreateHooks.clear();
  itemUpdateHooks.clear();
  relationEdgeWriteHooks.clear();
  relationEdgeDeleteHooks.clear();
  itemPreWriteTransforms.clear();
}
