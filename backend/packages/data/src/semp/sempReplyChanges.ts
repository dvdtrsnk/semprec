import type { AgentRunEventRow } from "../agentRuns/agentRunEventsStore.js";
import { boundValue } from "../agentRuns/agentRunStepPages.js";
import type { SempReplyTargets } from "./sempReplyTargets.js";
import {
  pairSempToolCalls,
  sempToolCallApprovalRequestId,
  sempToolCallCreatedItemId,
  sempToolCallResultItem,
  sempUuid,
  type SempToolCall,
} from "./sempReplyToolCalls.js";

/**
 * The items a Semp reply changed, stored on the assistant message so the set outlives event retention; items keep
 * no author or history to rebuild it from.
 */

export type SempReplyChangeKind = "created" | "updated" | "deleted" | "restored" | "revised";

export interface SempReplyChange {
  itemId: string;
  databaseId: string;
  change: SempReplyChangeKind;
  changedKeys: string[];
  /** Values before the reply's first change of each key; absent for created items and sensitive databases. */
  before?: Record<string, unknown>;
  /** The card a `revised` change belongs to; no mapping sets it yet. */
  proposalId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Receives only calls that ran and did not fail (approval-request calls and unmapped tools are filtered out).
 * Returns `null` only when the item or database cannot be placed. Keys hidden by redacted arguments are left
 * out, but the call is still an entry because its result proves it ran.
 */
type ChangeMapping = (call: SempToolCall, targets: SempReplyTargets) => SempReplyChange | null;

/**
 * The result's item, else the one the arguments name. The database is where `targets` (tenant-scoped) found the
 * item, never one the stored text names; an item not found makes no entry.
 */
function changedItem(call: SempToolCall, targets: SempReplyTargets): { itemId: string; databaseId: string } | null {
  const itemId = sempUuid(sempToolCallResultItem(call)?.id ?? call.targetItemId ?? call.args.itemId);
  const databaseId = itemId === null ? undefined : targets.items.get(itemId)?.databaseId;
  return itemId === null || databaseId === undefined ? null : { itemId, databaseId };
}

/** Marked sensitive, redacted, or not placeable. */
function isSensitive(call: SempToolCall, databaseId: string, targets: SempReplyTargets): boolean {
  const database = targets.databases.get(databaseId);
  return call.redacted || database === undefined || database.sensitive;
}

/** Keys of `properties` and linked `relations`; none when the arguments were stored redacted. */
function createdKeys(args: SempToolCall["args"]): string[] {
  const keys = new Set(isRecord(args.properties) ? Object.keys(args.properties) : []);
  if (Array.isArray(args.relations)) {
    for (const relation of args.relations as unknown[]) {
      if (isRecord(relation) && typeof relation.propertyKey === "string" && hasEntries(relation.targetItemIds)) {
        keys.add(relation.propertyKey);
      }
    }
  }
  return [...keys];
}

function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/**
 * The id falls back to `details.createdItemId`, so a create in a sensitive database (redacted result) is still an
 * entry. No `before`, so nothing of the content is stored.
 */
const createdItem: ChangeMapping = (call, targets) => {
  const itemId = sempToolCallCreatedItemId(call);
  const databaseId = itemId === null ? undefined : targets.items.get(itemId)?.databaseId;
  if (itemId === null || databaseId === undefined) return null;
  return { itemId, databaseId, change: "created", changedKeys: createdKeys(call.args) };
};

const patchedItem: ChangeMapping = (call, targets) => {
  const item = changedItem(call, targets);
  if (!item) return null;
  const changes = call.result?.details?.changes ?? [];
  const before: Record<string, unknown> = {};
  if (!isSensitive(call, item.databaseId, targets)) {
    for (const change of changes) if (change.before !== undefined) before[change.key] = boundValue(change.before);
  }
  return {
    ...item,
    change: "updated",
    changedKeys: changes.map((change) => change.key),
    ...(Object.keys(before).length > 0 ? { before } : {}),
  };
};

function wholeItem(change: "deleted" | "restored"): ChangeMapping {
  return (call, targets) => {
    const item = changedItem(call, targets);
    return item ? { ...item, change, changedKeys: [] } : null;
  };
}

/**
 * A link written or removed updates the calling item (`targetItemId`, else the argument) under the relation
 * property's key, which comes from the arguments only; redacted arguments give an entry with no key.
 */
const relationChange: ChangeMapping = (call, targets) => {
  const itemId = sempUuid(call.targetItemId ?? call.args.callerItemId);
  const item = itemId === null ? undefined : targets.items.get(itemId);
  if (itemId === null || !item) return null;
  const propertyId = sempUuid(call.args.relationPropertyId);
  const property = propertyId === null ? undefined : targets.properties.get(propertyId);
  return { itemId, databaseId: item.databaseId, change: "updated", changedKeys: property ? [property.key] : [] };
};

/** A module adding an item-changing agent tool adds its entry here. */
const CHANGE_MAPPINGS: Readonly<Record<string, ChangeMapping>> = {
  "item.create": createdItem,
  "item.patch": patchedItem,
  "item.delete": wholeItem("deleted"),
  "item.restore": wholeItem("restored"),
  "relation.put": relationChange,
  "relation.delete": relationChange,
};

/**
 * Keys are united and each keeps the `before` of its first change. A created item stays `created` with no
 * `before`; any other takes the kind of its last change.
 */
function mergeChanges(first: SempReplyChange, next: SempReplyChange): SempReplyChange {
  const created = first.change === "created";
  const keys = new Set(first.changedKeys);
  const before: Record<string, unknown> = { ...first.before };
  for (const key of next.changedKeys) {
    if (!keys.has(key) && next.before !== undefined && Object.hasOwn(next.before, key)) before[key] = next.before[key];
    keys.add(key);
  }
  return {
    itemId: first.itemId,
    databaseId: first.databaseId,
    change: created && next.change !== "deleted" ? "created" : next.change,
    changedKeys: [...keys],
    ...(!created && Object.keys(before).length > 0 ? { before } : {}),
  };
}

/** One entry per item in order of first change; `[]` when nothing changed. */
export function projectSempReplyChanges(input: {
  events: readonly AgentRunEventRow[];
  targets: SempReplyTargets;
}): SempReplyChange[] {
  const merged = new Map<string, SempReplyChange>();
  for (const call of pairSempToolCalls(input.events)) {
    const mapping = call.operation === undefined ? undefined : CHANGE_MAPPINGS[call.operation];
    if (!mapping || call.result === null || call.failed || sempToolCallApprovalRequestId(call) !== undefined) continue;
    const change = mapping(call, input.targets);
    if (!change) continue;
    const earlier = merged.get(change.itemId);
    merged.set(change.itemId, earlier ? mergeChanges(earlier, change) : change);
  }
  return [...merged.values()];
}
