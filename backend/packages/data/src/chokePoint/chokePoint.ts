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
import { listItemRelationsWithClient, type ItemRelationEntry, type VisibleItemRelationEntry } from "./relationReads.js";
import { listRelatedWithClient, type RelatedResolver } from "./relatedOps.js";
import { withTransaction } from "../db/pool.js";
import { getDerivedValuesForItems } from "../derived/derivedValueReads.js";
import { runAutomationBatchReader } from "./hooks.js";
import type { ItemAutomationReadPort } from "@semprec/shared";
import { getItemsByIds } from "./itemsStore.js";
import { listUnreadableDatabaseIds, type DatabaseReader } from "../agentGrants/agentDatabaseAccess.js";

export function createChokePoint(
  pool: Pool,
  computedKeyRegistry: ComputedKeyRegistry = createComputedKeyRegistry(),
  viewTypeRegistry: ViewTypeRegistry = createViewTypeRegistry(),
  queueAffinity: ActionQueueAffinity = createActionQueueAffinity(),
) {
  const deps: ChokePointDeps = { pool, computedKeyRegistry, viewTypeRegistry, queueAffinity };

  /**
   * The live relation edges of one item from its own side; `null` when the item is not found. A
   * `reader` needs `read` on the item's database and sees an edge into a database it may not read as a
   * `HiddenItemRelationEntry`; without a reader every edge is returned in full.
   */
  function listItemRelations(itemId: string, relationPropertyId?: string): Promise<VisibleItemRelationEntry[] | null>;
  function listItemRelations(
    itemId: string,
    relationPropertyId: string | undefined,
    reader: DatabaseReader | undefined,
  ): Promise<ItemRelationEntry[] | null>;
  function listItemRelations(itemId: string, relationPropertyId?: string, reader?: DatabaseReader) {
    return withTransaction(pool, (client) => listItemRelationsWithClient(client, itemId, relationPropertyId, reader));
  }

  /**
   * The collections related to one item; `null` when the item is not found. A `reader` needs `read` on
   * the item's database and gets no collection it may not read.
   */
  function listRelatedCollections(itemId: string, resolver: RelatedResolver, reader?: DatabaseReader) {
    return withTransaction(pool, (client) => listRelatedWithClient(client, itemId, resolver, reader));
  }

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
      /**
       * The value links for `include=links`. An agent gets no source item from a database its project may
       * not read; an external client none from a sensitive database.
       */
      async getValueLinksForItems(
        itemIds: string[],
        includeDerived = false,
        preloadedDerived?: Parameters<typeof getValueLinksForItems>[3],
        reader?: DatabaseReader,
      ) {
        return withTransaction(pool, async (client) =>
          getValueLinksForItems(
            client,
            itemIds,
            includeDerived,
            preloadedDerived,
            reader === undefined ? undefined : await listUnreadableDatabaseIds(client, reader),
          ),
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
      listItemRelations,
      listRelatedCollections,
    },
  );
}

export type ChokePoint = ReturnType<typeof createChokePoint>;
