import type { PoolClient } from "pg";
import type { SearchGroupType, SearchItemGroupType, SearchMailResult, SearchThreadResult } from "@semprec/shared";
import type { ThreadSearchQueryBuilder } from "./sempThreadSearch.js";

// The per-process registry of the groups of global search. `searchItemGroups` reads it and names no group; the
// composition root `domainWriteHooks.ts` fills it. It lives here and not in `chokePoint/hooks.ts` because search is
// not a write path and `clearHooksForTests`, which several tests call, must not empty it. See
// docs/adr/2026-11-13-search-groups-register-through-a-per-process-registry.md.

/** The group types whose results are threads, not items. */
export type SearchThreadGroupType = Exclude<SearchGroupType, SearchItemGroupType>;

/** An item-backed group: the databases of these owner modules are searched, and each match is one result. */
export interface ItemSearchGroup {
  type: SearchItemGroupType;
  ownerModuleIds: readonly string[];
}

/** What a thread group is asked, beyond the transaction's client: the facts `searchItemGroups` has. */
export interface ThreadSearchRequest {
  /** The search text. It is bound as a parameter by `buildQuery` and is never logged. */
  q: string;
  /** The shared tsquery builder; `buildQuery(n)` numbers the parameters from `$n`. */
  buildQuery: ThreadSearchQueryBuilder;
  /** The most results returned: the `perGroupLimit` of the search. */
  limit: number;
  /** The Projects item of an agent's run; absent for a person. */
  agentProjectItemId?: string;
  /** True when a person asks; false for an agent run or an MCP session. The group applies its own actor rule. */
  humanActor: boolean;
}

export interface ThreadSearchPage {
  /** Every matching result of the group, whatever the page or the cursor. */
  total: number;
  /** A `mail` entry also names the Emails item of the thread's last message; a `chat` entry does not. */
  items: Array<SearchMailResult | SearchThreadResult>;
  nextCursor: string | null;
}

/** A thread group's search, bound to the cursor that `prepare` parsed. It runs in the caller's transaction and tenant scope. */
export type ThreadSearchRun = (client: PoolClient, request: ThreadSearchRequest) => Promise<ThreadSearchPage>;

/** A thread-backed group: each match is a thread, and the group owns the shape of its own cursor. */
export interface ThreadSearchGroup {
  type: SearchThreadGroupType;
  /**
   * Validates `cursor`, the token of this group's own `nextCursor`, throwing the group's `ValidationError` for a
   * malformed one, and returns the search bound to the parsed cursor. `cursor` is undefined when the search names no
   * cursor, or names scopes of more than this one group.
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

/** Registers the databases of an item group. The same object twice is a no-op; a different one for the type throws. */
export function registerItemSearchGroup(group: ItemSearchGroup): void {
  register(group);
}

/** Registers a thread group. The same object twice is a no-op; a different one for the type throws. */
export function registerThreadSearchGroup(group: ThreadSearchGroup): void {
  register(group);
}

/** The registration of `type`, or `undefined` when none was made. */
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
