// The choke point's own registries for a domain's transaction-scoped write side effects — a
// shared module in the sense of docs/adr/2026-09-24-choke-point-composed-from-domain-modules.md,
// owned by no domain. `itemWrites.ts`/`relationOps.ts` call `run*` inside the same transaction
// as the write itself; a domain module registers its hook through `../domainWriteHooks.ts`, the
// one composition point that knows every domain by name so `chokePoint/` does not have to.
// Constrained by: docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md
import type { PoolClient } from "pg";
import type { DatabaseRow, ItemRow } from "../types.js";
import type { RelationEdgeContext } from "./relationEdgeContext.js";

export interface ItemUpdateHookContext {
  client: PoolClient;
  database: DatabaseRow;
  item: ItemRow;
  propertiesPatch: Record<string, unknown>;
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
}

export type RelationEdgeWriteHook = (context: RelationEdgeWriteHookContext) => Promise<void>;

const itemUpdateHooks = new Set<ItemUpdateHook>();
const relationEdgeWriteHooks = new Set<RelationEdgeWriteHook>();

/** Registering the same function twice is a no-op — a hook module imported from more than one place still runs once. */
export function registerItemUpdateHook(hook: ItemUpdateHook): void {
  itemUpdateHooks.add(hook);
}

export function registerRelationEdgeWriteHook(hook: RelationEdgeWriteHook): void {
  relationEdgeWriteHooks.add(hook);
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

/** Test-only reset of both registries — guarded so it cannot run against a real process's hooks. */
export function clearHooksForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("clearHooksForTests() must only be called in tests");
  }
  itemUpdateHooks.clear();
  relationEdgeWriteHooks.clear();
}
