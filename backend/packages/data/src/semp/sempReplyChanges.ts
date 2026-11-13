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
 * The items a Semp reply changed (issue #1885), stored on the assistant message when its turn ends so the set
 * outlives the 30-day retention of the events and items keep no author or history to rebuild it from.
 */

export type SempReplyChangeKind = "created" | "updated" | "deleted" | "restored" | "revised";

export interface SempReplyChange {
  itemId: string;
  databaseId: string;
  change: SempReplyChangeKind;
  /** The property keys the reply set, changed, linked or unlinked on the item. */
  changedKeys: string[];
  /** The values the changed keys had before the reply's first change of each; absent for a created item and for a sensitive database. */
  before?: Record<string, unknown>;
  /** The card a `revised` change belongs to; no mapping sets it, because the Inbox revise tool of issue #1906, whose result it would come from, does not exist yet. */
  proposalId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What one tool call did to an item. The mapping receives only a call that ran and did not fail: a call that
 * failed, one that created an approval request instead of running (a delete waiting for a person is not a
 * change) and a tool that is not in the mapping never reach it (`projectSempReplyChanges`). It returns `null`
 * only when the item or its database cannot be placed. A key it cannot read (the arguments of a call can be
 * stored redacted) is left out of `changedKeys`; the call is still an entry, because its result proves it ran.
 */
type ChangeMapping = (call: SempToolCall, targets: SempReplyTargets) => SempReplyChange | null;

/**
 * The item a call changed and its database: the item of its result, else the one its arguments name. The
 * database is the one the item is found in (`targets`, read in the caller's tenant scope), never one the stored
 * text names; an item that is not found there makes no entry.
 */
function changedItem(call: SempToolCall, targets: SempReplyTargets): { itemId: string; databaseId: string } | null {
  const itemId = sempUuid(sempToolCallResultItem(call)?.id ?? call.targetItemId ?? call.args.itemId);
  const databaseId = itemId === null ? undefined : targets.items.get(itemId)?.databaseId;
  return itemId === null || databaseId === undefined ? null : { itemId, databaseId };
}

/** Whether the content of the call's database must not be stored: marked sensitive, redacted, or not placeable. */
function isSensitive(call: SempToolCall, databaseId: string, targets: SempReplyTargets): boolean {
  const database = targets.databases.get(databaseId);
  return call.redacted || database === undefined || database.sensitive;
}

/**
 * The keys a create set: those of `properties` and the relation properties it linked (`relations`). The arguments
 * of a call can be stored redacted, and then no key can be read.
 */
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
 * The item id comes from the result, else from the id the tool kept in the result's details, so a create in a
 * sensitive database (its result text is stored redacted) is still an entry. It has no `before`, so nothing of
 * the item's content is stored.
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
 * A link written or removed is an update of the calling item, under the key of the relation property. The calling
 * item is the one the call's events name (`targetItemId`), else the one its arguments name; the property key comes
 * from the arguments only, so a call whose arguments were stored redacted is an entry with no key.
 */
const relationChange: ChangeMapping = (call, targets) => {
  const itemId = sempUuid(call.targetItemId ?? call.args.callerItemId);
  const item = itemId === null ? undefined : targets.items.get(itemId);
  if (itemId === null || !item) return null;
  const propertyId = sempUuid(call.args.relationPropertyId);
  const property = propertyId === null ? undefined : targets.properties.get(propertyId);
  return { itemId, databaseId: item.databaseId, change: "updated", changedKeys: property ? [property.key] : [] };
};

/**
 * The mapping from a tool to the change it makes, keyed by the generic operation's name. A module that adds an
 * agent tool which changes items adds its entry here.
 */
const CHANGE_MAPPINGS: Readonly<Record<string, ChangeMapping>> = {
  "item.create": createdItem,
  "item.patch": patchedItem,
  "item.delete": wholeItem("deleted"),
  "item.restore": wholeItem("restored"),
  "relation.put": relationChange,
  "relation.delete": relationChange,
};

/**
 * Folds the several changes of one item into one entry: the keys are united and each key keeps the `before` of
 * its first change. An item the reply created stays `created` however it was changed afterwards and has no
 * `before`; any other item takes the kind of its last change.
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

/**
 * The changes of one turn, from its events (`agent_run_id` = the message's run and `id` between its
 * `event_from_id` and `event_to_id`), one entry per item in the order of its first change. A call is matched
 * to its result on `toolCallId`; only a call that ran and did not fail makes an entry. The array is stored in
 * `semp_messages.changes`; a turn that changed nothing gives `[]`.
 */
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
