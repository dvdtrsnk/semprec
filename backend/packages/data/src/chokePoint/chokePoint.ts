import type { Pool } from "pg";
import { createActionQueueAffinity, type ActionQueueAffinity } from "../scheduler/actions.js";
import { createComputedKeyRegistry, type ComputedKeyRegistry } from "./computedKeyRegistry.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "./viewTypeRegistry.js";
import type { ChokePointDeps } from "./chokePointDeps.js";
import { mergeOps } from "./mergeOps.js";
import { createDatabaseOps } from "./databaseOps.js";
import { createItemReadOps } from "./itemReads.js";
import { createViewQueryOps } from "./viewQueryOps.js";
import { createViewOps } from "./viewOps.js";
import { createPropertyOps } from "./propertyOps.js";
import { createRelationPropertyOps } from "./relationPropertyOps.js";
import { createRelationOps } from "./relationOps.js";
import { createItemWriteOps } from "./itemWrites.js";
import { createItemWithRelationsOps } from "./itemCreateWithRelations.js";
import { createValueLinkOps } from "./valueLinkOps.js";
import { createItemTrashOps } from "./itemTrash.js";
import { getValueLinksForItems } from "./valueLinkReads.js";
import { listItemRelationsWithClient } from "./relationReads.js";
import { withTransaction } from "../db/pool.js";
import { getDerivedValuesForItems } from "../derived/derivedValueReads.js";
import { runAutomationBatchReader } from "./hooks.js";
import type { ItemAutomationReadPort } from "@semprec/shared";
import { getItemsByIds } from "./itemsStore.js";

export function createChokePoint(
  pool: Pool,
  computedKeyRegistry: ComputedKeyRegistry = createComputedKeyRegistry(),
  viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry(),
  queueAffinity: ActionQueueAffinity = createActionQueueAffinity(),
) {
  const deps: ChokePointDeps = { pool, computedKeyRegistry, viewTypeRegistry, queueAffinity };
  return mergeOps(
    createDatabaseOps(deps),
    createPropertyOps(deps),
    createRelationPropertyOps(deps),
    createRelationOps(deps),
    createItemWriteOps(deps),
    createItemWithRelationsOps(deps),
    createItemReadOps(deps),
    createItemTrashOps(deps),
    createValueLinkOps(deps),
    createViewOps(deps),
    createViewQueryOps(deps),
    {
      /** The value links of a set of items for `include=links` (issue #1403), in one transaction. */
      async getValueLinksForItems(
        itemIds: string[],
        includeDerived = false,
        preloadedDerived?: Parameters<typeof getValueLinksForItems>[3],
      ) {
        return withTransaction(pool, (client) =>
          getValueLinksForItems(client, itemIds, includeDerived, preloadedDerived),
        );
      },
      async readAutomationForItems(itemIds: string[]): ReturnType<ItemAutomationReadPort["readAutomationForItems"]> {
        return withTransaction(pool, (client) => runAutomationBatchReader(client, itemIds));
      },
      async getDerivedValuesForItems(itemIds: string[]) {
        return withTransaction(pool, async (client) =>
          getDerivedValuesForItems(client, await getItemsByIds(client, itemIds)),
        );
      },
      /** The live relation edges of one item from its own side (issue #1404), in one transaction; `null` when the item is not found. */
      async listItemRelations(itemId: string, relationPropertyId?: string) {
        return withTransaction(pool, (client) => listItemRelationsWithClient(client, itemId, relationPropertyId));
      },
    },
  );
}

export type ChokePoint = ReturnType<typeof createChokePoint>;
