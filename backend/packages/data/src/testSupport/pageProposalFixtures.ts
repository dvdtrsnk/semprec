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

export interface PageProposalDatabases {
  inboxId: string;
  typesId: string;
  proposalsId: string;
}

/**
 * A `pageContent` proposal card for `target` via the production path (Inbox type, item, one tick answering
 * `{ target, properties }`), so the card holds the envelope exactly as the tick stores it. `properties` is
 * `{ markdown, placement, heading? }`. The caller supplies pool and tenant scope.
 */
export async function createMarkdownPageContentProposal(
  pool: Pool,
  databases: PageProposalDatabases,
  target: string,
  properties: Record<string, unknown>,
): Promise<ItemRow> {
  return createTickedProposal(pool, databases, "pageContent", { target, properties });
}

/**
 * A `journalEntry` proposal card via the production path; the tick answers `{ properties }` only, so the server
 * supplies the Journal database as target and the item's date as default `date`. The caller supplies pool and
 * tenant scope.
 */
export async function createJournalEntryProposal(
  pool: Pool,
  databases: PageProposalDatabases,
  properties: Record<string, unknown>,
): Promise<ItemRow> {
  return createTickedProposal(pool, databases, "journal", { properties });
}

async function createTickedProposal(
  pool: Pool,
  databases: PageProposalDatabases,
  processingMethod: "pageContent" | "journal",
  result: { target?: string; properties: Record<string, unknown> },
): Promise<ItemRow> {
  const type = await withTransaction(pool, (client) =>
    createInboxTypeWithClient(client, {
      inboxItemTypesDatabaseId: databases.typesId,
      name: `Page note ${randomUUID()}`,
      emoji: "📝",
      processingMethod,
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
  const tick = createSemprecTickAction(pool, async () => result);
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
