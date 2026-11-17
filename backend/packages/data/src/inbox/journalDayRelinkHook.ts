// A trashed Journal day entry keeps its `journalDay` edges, and the next write for that day creates a different entry,
// so this hook moves the day's Inbox items to the new entry. It belongs to Inbox because the edge and its relation
// context do. Runs in the create's transaction after a real insert, never on an idempotency replay.
import type { ItemCreateHook } from "../chokePoint/hooks.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { enqueueJournalInboxRecompute } from "./journalInboxCompute.js";

/** The identity Inbox capture writes the `journalDay` edge with. */
const INBOX_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: INBOX_MODULE_ID };

/** Recomputes the new entry and every old entry that lost an item, so stale cached lists are emptied. */
export const journalDayRelinkItemCreateHook: ItemCreateHook = async ({ client, database, item, properties }) => {
  const period = properties.period;
  if (database.ownerModuleId !== JOURNAL_MODULE_ID || properties.type !== "day" || typeof period !== "string") return;

  const trashed = await client.query<{ id: string }>(
    `SELECT id FROM items
     WHERE database_id = $1 AND id <> $2 AND deleted_at IS NOT NULL
       AND properties->>'type' = 'day' AND properties->>'period' = $3
     ORDER BY id`,
    [database.id, item.id, period],
  );
  if (trashed.rows.length === 0) return;

  const inbox = await databasesStore.getDatabaseByModuleId(client, INBOX_MODULE_ID);
  const journalDayProperty = inbox ? await propertiesStore.getPropertyByKey(client, inbox.id, "journalDay") : null;
  const definition = journalDayProperty
    ? await relationsStore.getRelationDefinitionByPropertyId(client, journalDayProperty.id)
    : null;
  if (!inbox || !journalDayProperty || !definition) throw new Error("Inbox 'journalDay' relation not found");

  for (const { id: oldDayId } of trashed.rows) {
    const edges = await relationsStore.listRelationsForItem(client, definition.id, oldDayId);
    let moved = 0;
    for (const edge of edges) {
      const inboxItemId = relationsStore.otherSide(edge, oldDayId);
      const inboxItem = await itemsStore.getItemById(client, inbox.id, inboxItemId);
      if (!inboxItem || inboxItem.deletedAt) continue;
      await deleteRelationWithClient(
        client,
        { relationPropertyId: journalDayProperty.id, callerItemId: inboxItemId, targetItemId: oldDayId },
        INBOX_RELATION_CONTEXT,
      );
      await createRelationWithClient(
        client,
        { relationPropertyId: journalDayProperty.id, callerItemId: inboxItemId, targetItemId: item.id },
        INBOX_RELATION_CONTEXT,
      );
      moved++;
    }
    if (moved === 0) continue;
    await enqueueJournalInboxRecompute(client, oldDayId);
    await enqueueJournalInboxRecompute(client, item.id);
  }
};
