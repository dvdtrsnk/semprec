import type { PoolClient } from "pg";
import type { SearchGroupType, SearchItemGroupType, SearchMailResult, SearchThreadResult } from "@alldots/shared";
import type { ThreadSearchQueryBuilder } from "./sempThreadSearch.js";

// Per-process registry of global search groups, filled by the composition root. Not in `chokePoint/hooks.ts`
// because search is not a write path and `clearHooksForTests` must not empty it.

export type SearchThreadGroupType = Exclude<SearchGroupType, SearchItemGroupType>;

/** The databases of these owner modules are searched; each match is one result. */
export interface ItemSearchGroup {
  type: SearchItemGroupType;
  ownerModuleIds: readonly string[];
}

export interface ThreadSearchRequest {
  /** Bound by `buildQuery`; never logged. */
  q: string;
  /** `buildQuery(n)` numbers the parameters from `$n`. */
  buildQuery: ThreadSearchQueryBuilder;
  /** The search's `perGroupLimit`. */
  limit: number;
  /** An agent run's Projects item; absent for a person. */
  agentProjectItemId?: string;
  /** False for an agent run or MCP session; the group applies its own actor rule. */
  humanActor: boolean;
}

export interface ThreadSearchPage {
  /** Every match, whatever the page or cursor. */
  total: number;
  /** A `mail` entry also names the Emails item of the thread's last message. */
  items: Array<SearchMailResult | SearchThreadResult>;
  nextCursor: string | null;
}

/** Bound to the cursor `prepare` parsed; runs in the caller's transaction and tenant scope. */
export type ThreadSearchRun = (client: PoolClient, request: ThreadSearchRequest) => Promise<ThreadSearchPage>;

/** The group owns the shape of its own cursor. */
export interface ThreadSearchGroup {
  type: SearchThreadGroupType;
  /**
   * Throws the group's `ValidationError` for a malformed `cursor`. `cursor` is undefined when none is given or the
   * scope names more than this group.
   */
  prepare(cursor: string | undefined): ThreadSearchRun;
}

const groups = new Map<SearchGroupType, ItemSearchGroup | ThreadSearchGroup>();

function register(group: ItemSearchGroup | ThreadSearchGroup): void {
  const registered = groups.get(group.type);
  if (registered === group) return;
  if (registered !== undefined) throw new Error(`A search group is already registered for type "${group.type}"`);
  groups.set(group.type, group);
}

/** The same object twice is a no-op; a different one for the type throws. */
export function registerItemSearchGroup(group: ItemSearchGroup): void {
  register(group);
}

/** The same object twice is a no-op; a different one for the type throws. */
export function registerThreadSearchGroup(group: ThreadSearchGroup): void {
  register(group);
}

export function getSearchGroup(type: SearchItemGroupType): ItemSearchGroup | undefined;
export function getSearchGroup(type: SearchThreadGroupType): ThreadSearchGroup | undefined;
export function getSearchGroup(type: SearchGroupType): ItemSearchGroup | ThreadSearchGroup | undefined;
export function getSearchGroup(type: SearchGroupType): ItemSearchGroup | ThreadSearchGroup | undefined {
  return groups.get(type);
}

export function clearSearchGroupsForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("clearSearchGroupsForTests() must only be called in tests");
  }
  groups.clear();
}
