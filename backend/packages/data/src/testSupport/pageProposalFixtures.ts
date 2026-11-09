import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { withTransaction } from "../db/pool.js";
import { createSemprecTickAction } from "../inbox/inboxTickAction.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import type { ItemRow } from "../types.js";

/** The ids of the three Inbox databases a page-content proposal is made through. */
export interface PageProposalDatabases {
  inboxId: string;
  typesId: string;
  proposalsId: string;
}

/**
 * Creates a `pageContent` proposal card for `target` through the production path: an active `pageContent` Inbox type,
 * an Inbox item of that type and one tick whose computation answers `{ target, properties }`, so the card holds the
 * validated envelope exactly as the tick stores it. `properties` is the v2 `{ markdown, placement, heading? }` shape.
 * The caller supplies the pool and the tenant scope, and confirms the card through the production confirm.
 */
export async function createMarkdownPageContentProposal(
  pool: Pool,
  databases: PageProposalDatabases,
  target: string,
  properties: Record<string, unknown>,
): Promise<ItemRow> {
  const type = await withTransaction(pool, (client) =>
    createInboxTypeWithClient(client, {
      inboxItemTypesDatabaseId: databases.typesId,
      name: `Page note ${randomUUID()}`,
      emoji: "📝",
      processingMethod: "pageContent",
    }),
  );
  const item = await withTransaction(pool, (client) =>
    createInboxItemWithClient(client, {
      inboxDatabaseId: databases.inboxId,
      date: "2026-08-28",
      time: "09:00",
      text: "Add to the page",
      type: type.id,
    }),
  );
  const tick = createSemprecTickAction(pool, async () => ({ target, properties }));
  await tick(
    {
      inboxDatabaseId: databases.inboxId,
      inboxItemTypesDatabaseId: databases.typesId,
      processingProposalsDatabaseId: databases.proposalsId,
    },
    { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
  );
  return withTransaction(pool, async (client) => {
    const sourceInbox = await propertiesStore.getPropertyByKey(client, databases.proposalsId, "sourceInbox");
    if (!sourceInbox) throw new Error("The proposals database has no sourceInbox property");
    const definition = await relationsStore.getRelationDefinitionByPropertyId(client, sourceInbox.id);
    if (!definition) throw new Error("The sourceInbox property has no relation definition");
    const edges = await relationsStore.listRelationsForItem(client, definition.id, item.id);
    const edge = edges[0];
    if (!edge) throw new Error("The tick stored no proposal card");
    const card = await itemsStore.getItemById(client, databases.proposalsId, relationsStore.otherSide(edge, item.id));
    if (!card) throw new Error("The proposal card is missing");
    return card;
  });
}
