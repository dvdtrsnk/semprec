// The choke point's item-create hook (registered by `../domainWriteHooks.ts`) that re-links a trashed Journal day's
// Inbox items to the day's new entry (issue #1603). A trashed entry keeps its `journalDay` edges, and the next write
// for that day creates a different entry, so without this the day's Inbox items would drop out of its Inbox section.
// The hook belongs to the Inbox module because the edge and its relation context belong to Inbox. It runs inside the
// create's transaction after a real insert and never on an idempotency replay, so every caller that creates a day
// entry through the choke point is covered. See docs/adr/2026-10-09-item-create-domain-hooks.md.
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

/** The same Inbox process identity Inbox capture writes the `journalDay` edge with (`inboxCreateHook.ts`). */
const INBOX_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: INBOX_MODULE_ID };

/**
 * For a new Journal entry of `type = day`: finds the trashed day entries with the same `period`, moves the
 * `journalDay` edge of each of their live Inbox items to the new entry (delete, then create, with the Inbox context)
 * and enqueues the Inbox recompute for the new entry and for every old entry that lost an item, so the old cached
 * lists are emptied. Writes nothing when no trashed entry of the period exists or none of them has live Inbox items.
 */
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
