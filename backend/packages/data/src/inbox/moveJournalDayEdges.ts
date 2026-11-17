// Moves the Inbox items of one Journal day entry to another entry of the same day, for merging duplicate Journal
// entries. Lives in Inbox because the `journalDay` edge, its process identity and a day's cached Inbox list are Inbox's.
import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { moveRelationEdgesWithClient, type RefusedRelationEdge } from "../chokePoint/relationOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { enqueueJournalInboxRecompute } from "./journalInboxCompute.js";

const INBOX_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: INBOX_MODULE_ID };

/**
 * Moves the `journalDay` edge of each live Inbox item from `fromDayItemId` to `toDayItemId` in the caller's
 * transaction (trashed items keep theirs), and enqueues both entries' Inbox recompute when any edge moved. Returns the
 * edges the choke point refuses for `toDayItemId`, which stay on `fromDayItemId`.
 */
export async function moveJournalDayEdges(
  client: PoolClient,
  input: { fromDayItemId: string; toDayItemId: string },
): Promise<RefusedRelationEdge[]> {
  const inbox = await databasesStore.getDatabaseByModuleId(client, INBOX_MODULE_ID);
  const journalDayProperty = inbox ? await propertiesStore.getPropertyByKey(client, inbox.id, "journalDay") : null;
  if (!journalDayProperty) throw new Error("Inbox 'journalDay' relation not found");

  const { moved, refused } = await moveRelationEdgesWithClient(
    client,
    {
      relationPropertyId: journalDayProperty.id,
      side: "target",
      fromItemId: input.fromDayItemId,
      toItemId: input.toDayItemId,
    },
    INBOX_RELATION_CONTEXT,
  );
  if (moved > 0) {
    await enqueueJournalInboxRecompute(client, input.fromDayItemId);
    await enqueueJournalInboxRecompute(client, input.toDayItemId);
  }
  return refused;
}
