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
 * What the tool calls of a Semp turn point at, read once when the turn ends (issues #1860 and #1885): the items
 * they name, the databases those items and the calls are in, and the relation properties they link through. The
 * summaries store a name or a database fact only from here, never from a call's text.
 */
export interface SempReplyTargets {
  /** The items by id, trashed ones included; `name` is the item's title (else `name`) property, `null` when neither is text. */
  items: ReadonlyMap<string, { databaseId: string; name: string | null }>;
  /** The databases by id: the module that owns it (`null` for none) and whether its content is marked sensitive. */
  databases: ReadonlyMap<string, { moduleId: string | null; sensitive: boolean }>;
  /** The relation properties by id. */
  properties: ReadonlyMap<string, { key: string }>;
}

/**
 * The ids a generic operation's call names: the items of its `itemId`, `callerItemId`, result and (for a create)
 * `createdItemId`, the databases of its `databaseId` and result, and the relation property of its
 * `relationPropertyId`. The model wrote the arguments, so only a uuid is kept and the lookup (in the caller's
 * tenant scope) decides whether it names anything. An MCP tool and a tool without identity name nothing.
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

/**
 * Resolves `calls` to their targets in three queries, however many calls there are. Everything is read
 * under the caller's tenant scope, so an id of another tenant is simply not found. The databases of the found
 * items are read with the databases the calls name.
 */
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
