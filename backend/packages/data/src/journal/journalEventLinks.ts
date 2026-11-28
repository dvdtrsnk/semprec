import { collectItemLinks, parseMarkdown } from "@alldots/block-model";
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { JOURNAL_EVENT_LINKS_OWNER_PROCESS } from "./journalOwnerProcesses.js";

const JOURNAL_EVENT_LINKS_CONTEXT: SystemRelationWriteContext = { ownerProcess: JOURNAL_EVENT_LINKS_OWNER_PROCESS };

/**
 * Keeps `events` equal to the live Events the page links to (`alldots://items/<id>`); other links are plain content.
 * Nothing is written when the sets already match. The entry row is locked before its edges are read, so two syncs
 * of one entry serialize. RLS hides other tenants' items, so a link to one creates no edge.
 */
export async function syncJournalEventLinks(
  client: PoolClient,
  journalItemId: string,
  markdown: string,
): Promise<void> {
  const journal = await getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
  const property = journal ? await propertiesStore.getPropertyByKey(client, journal.id, "events") : null;
  const definition = property ? await relationsStore.getRelationDefinitionByPropertyId(client, property.id) : null;
  const eventsDatabaseId = property?.config.targetDatabaseId;
  if (!journal || !property || !definition || typeof eventsDatabaseId !== "string") {
    throw new Error("Journal has no 'events' relation");
  }
  const entry = await itemsStore.lockItemById(client, journal.id, journalItemId);
  if (!entry || entry.deletedAt) return;

  const linkedIds = collectItemLinks(parseMarkdown(markdown)).ids;
  const live =
    linkedIds.length === 0
      ? []
      : (
          await client.query<{ id: string }>(
            "SELECT id FROM items WHERE database_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL",
            [eventsDatabaseId, linkedIds],
          )
        ).rows.map((row) => row.id);
  const wanted = new Set(live);
  const edges = await relationsStore.listRelationsForItem(client, definition.id, journalItemId);
  const current = new Set(edges.map((edge) => relationsStore.otherSide(edge, journalItemId)));

  for (const eventId of [...wanted].sort()) {
    if (current.has(eventId)) continue;
    await createRelationWithClient(
      client,
      { relationPropertyId: property.id, callerItemId: journalItemId, targetItemId: eventId },
      JOURNAL_EVENT_LINKS_CONTEXT,
    );
  }
  for (const eventId of [...current].sort()) {
    if (wanted.has(eventId)) continue;
    await deleteRelationWithClient(
      client,
      { relationPropertyId: property.id, callerItemId: journalItemId, targetItemId: eventId },
      JOURNAL_EVENT_LINKS_CONTEXT,
    );
  }
}
