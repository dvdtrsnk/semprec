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
   * The live relation edges of one item from its own side (issue #1404), in one transaction; `null` when the item is not
   * found. An agent (a `reader` that is its project, issue #1810) or an external client (issue #1998) needs `read`
   * access to the item's database and sees an edge to a database it may not read as a `HiddenItemRelationEntry`; a
   * read without a reader returns every edge in full.
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
       * The value links of a set of items for `include=links` (issue #1403), in one transaction. An agent (a `reader`
       * that is its project, issue #1849) gets no source item from a database its project may not read; an external
       * client (issue #1998) none from a sensitive database.
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
    },
  );
}

export type ChokePoint = ReturnType<typeof createChokePoint>;
