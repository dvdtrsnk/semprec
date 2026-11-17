import type { PoolClient } from "pg";
import { listDatabaseLabelsByIds } from "../chokePoint/databasesStore.js";
import { getItemsByIdsIncludingDeleted } from "../chokePoint/itemsStore.js";
import { listPropertiesByIds } from "../chokePoint/propertiesStore.js";
import {
  sempToolCallCreatedItemId,
  sempToolCallResultItem,
  sempUuid,
  type SempToolCall,
} from "./sempReplyToolCalls.js";

/**
 * What a turn's tool calls point at, read once when the turn ends. Summaries take names and database facts only
 * from here, never from a call's text.
 */
export interface SempReplyTargets {
  /** The items by id, trashed ones included; `name` is the item's title (else `name`) property, `null` when neither is text. */
  items: ReadonlyMap<string, { databaseId: string; name: string | null }>;
  /** The databases by id: the module that owns it (`null` for none) and whether its content is marked sensitive. */
  databases: ReadonlyMap<string, { moduleId: string | null; sensitive: boolean }>;
  properties: ReadonlyMap<string, { key: string }>;
}

/**
 * The model wrote the arguments, so only uuids are kept and the tenant-scoped lookup decides whether they name
 * anything. MCP tools and tools without identity name nothing.
 */
export function sempToolCallTargetIds(call: SempToolCall): {
  itemIds: string[];
  databaseIds: string[];
  propertyIds: string[];
} {
  if (call.operation === undefined) return { itemIds: [], databaseIds: [], propertyIds: [] };
  const answered = sempToolCallResultItem(call);
  const pick = (values: unknown[]): string[] => values.flatMap((value) => sempUuid(value) ?? []);
  return {
    itemIds: pick([
      call.targetItemId,
      call.args.itemId,
      call.args.callerItemId,
      answered?.id,
      sempToolCallCreatedItemId(call),
    ]),
    databaseIds: pick([call.targetDatabaseId, call.args.databaseId, answered?.databaseId]),
    propertyIds: pick([call.args.relationPropertyId]),
  };
}

/** Three queries however many calls, all under the caller's tenant scope, so foreign ids are simply not found. */
export async function loadSempReplyTargets(
  client: PoolClient,
  calls: readonly SempToolCall[],
): Promise<SempReplyTargets> {
  const ids = calls.map(sempToolCallTargetIds);
  const itemRows = await getItemsByIdsIncludingDeleted(client, [...new Set(ids.flatMap((id) => id.itemIds))]);
  const labels = await listDatabaseLabelsByIds(client, [
    ...new Set([...ids.flatMap((id) => id.databaseIds), ...itemRows.map((item) => item.databaseId)]),
  ]);
  const properties = await listPropertiesByIds(client, [...new Set(ids.flatMap((id) => id.propertyIds))]);
  const labelOf = new Map(labels.map((label) => [label.id, label]));
  return {
    items: new Map(
      itemRows.map((item) => {
        const titleKey = labelOf.get(item.databaseId)?.titlePropertyKey;
        const title = titleKey ? item.properties[titleKey] : undefined;
        const fallback = item.properties.name;
        const name = typeof title === "string" ? title : typeof fallback === "string" ? fallback : null;
        return [item.id, { databaseId: item.databaseId, name }] as const;
      }),
    ),
    databases: new Map(
      labels.map((label) => [label.id, { moduleId: label.ownerModuleId, sensitive: label.sensitive }] as const),
    ),
    properties: new Map(properties.map((property) => [property.id, { key: property.key }] as const)),
  };
}
