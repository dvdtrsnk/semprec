// Moves the Inbox items of one Journal day entry to another entry of the same day, for the merge of duplicate Journal
// entries (issue #1726). It belongs to the Inbox module for the reason `journalDayRelinkHook.ts` does: the `journalDay`
// edge, the process identity it is written with and the cached Inbox list of a day belong to Inbox.
// See docs/adr/2026-11-10-journal-duplicate-merge-locks-the-reservation-before-both-entries.md.
import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { moveRelationEdgesWithClient, type RefusedRelationEdge } from "../chokePoint/relationOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { enqueueJournalInboxRecompute } from "./journalInboxCompute.js";

/** The same Inbox process identity Inbox capture writes the `journalDay` edge with (`inboxCreateHook.ts`). */
const INBOX_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: INBOX_MODULE_ID };

/**
 * Moves the `journalDay` edge of each live Inbox item of the entry `fromDayItemId` to the entry `toDayItemId`, in the
 * caller's transaction, through `moveRelationEdgesWithClient` with the Inbox context: delete, then create. A trashed
 * Inbox item keeps its edge. When at least one edge was deleted from `fromDayItemId`, the Inbox recompute of both
 * entries is enqueued, so their cached Inbox lists follow; otherwise nothing is enqueued. Returns the edges that stay
 * on `fromDayItemId` because the choke point refuses them for `toDayItemId`, for the caller to report.
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
