// Coordinator of `property.option.remove`, which spans two write owners: the property's options
// (`propertiesStore`) and the item values holding the option (`itemWrites`), on one client.
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import type { PropertyType } from "../types.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import * as itemsStore from "./itemsStore.js";
import { updateItemWithClient } from "./itemWrites.js";
import * as propertiesStore from "./propertiesStore.js";
import { enqueuePropertySearchReindex } from "./propertyOps.js";
import { SYSTEM_WRITER } from "./writerKind.js";

/** `value` holds `optionKey` (as itself or in an array); a select is left empty, a multi_select without the key. */
function valueWithoutOption(value: unknown, optionKey: string, type: PropertyType): unknown[] | null {
  if (!Array.isArray(value)) return type === "multi_select" ? [] : null;
  const entries: unknown[] = value;
  return entries.filter((entry) => entry !== optionKey);
}

export function createPropertyOptionRemovalOps(deps: Pick<ChokePointDeps, "pool" | "queueAffinity">) {
  const { pool, queueAffinity } = deps;
  return {
    /**
     * Removes one option, also on a schema-locked database, and in the same transaction its key from every live and
     * trashed item value of the property. Lock order: the property row, then every item holding the key in id order.
     * A concurrent user or agent item write naming the property holds its row `FOR SHARE` from before its option
     * check until commit, so it either commits first and its value is cleared here, or checks after this commit and
     * no longer finds the option.
     *
     * A live item is written through `updateItemWithClient` (hooks, events, its invalidation and search reindex) as
     * the system writer: the new value is the stored one without the key, which may still hold a retired key the user
     * check would refuse. A trashed item, which `updateItemWithClient` does not write, gets its value set directly.
     */
    async removePropertyOption(propertyId: string, optionKey: string, actingUserId?: string): Promise<void> {
      await withTransaction(pool, async (client) => {
        const { property } = await propertiesStore.removePropertyOption(client, propertyId, optionKey);
        const holders = await itemsStore.lockItemsHoldingOption(client, property.databaseId, property.key, optionKey);
        for (const item of holders) {
          const value = valueWithoutOption(item.properties[property.key], optionKey, property.type);
          if (item.deletedAt === null) {
            await updateItemWithClient(
              client,
              { databaseId: property.databaseId, itemId: item.id, propertiesPatch: { [property.key]: value } },
              { queueAffinity, actingUserId, writer: SYSTEM_WRITER },
            );
          } else {
            await itemsStore.setTrashedItemProperty(client, property.databaseId, item.id, property.key, value);
          }
        }
        await enqueuePropertySearchReindex(client, [property.databaseId]);
        runAfterCommit(client, () =>
          notifyInvalidation({ scope: "schema", databaseId: property.databaseId, userId: actingUserId }),
        );
      });
    },
  };
}
