// Retires Semp drafts made outdated by the user's own message, inside the send-finalize or ingest transaction.
import type { PoolClient } from "pg";
import { z } from "zod";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { trashLockedDraft } from "./mailDraftTrash.js";
import { getMailDraft } from "./mailDraftsStore.js";
import { getMailMessageMetaByItemId } from "./mailMessageMetaStore.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { announceMailThreadChanged } from "./mailThreadActions.js";

export interface RetireSupersededSempDraftsInput {
  threadId: string;
  ownMessageDate: Date;
  /** The draft being sent, which stays. */
  excludeDraftItemId?: string;
}

const candidateRow = z.object({ emailItemId: z.uuid(), sourceDate: z.string().nullable() });

/**
 * Unsent agent drafts of a thread with their source message's `date`. Thread merges do not
 * re-point `mail_drafts.thread_id`, so ids merged into the thread (`mail_thread_aliases`) match too.
 */
const CANDIDATE_DRAFTS_SQL = `
SELECT d.email_item_id::text AS "emailItemId", source.properties->>'date' AS "sourceDate"
FROM mail_drafts d
JOIN items draft ON draft.tenant_id = d.tenant_id AND draft.database_id = $2::uuid AND draft.id = d.email_item_id
  AND draft.deleted_at IS NULL
JOIN items source ON source.tenant_id = d.tenant_id AND source.database_id = $2::uuid AND source.id = d.source_email_item_id
WHERE d.tenant_id = app_tenant_default() AND d.created_by = 'agent' AND d.last_edited_by = 'agent'
  AND d.sent_at IS NULL
  AND d.thread_id = ANY(
    ARRAY[$1::uuid] || ARRAY(
      SELECT a.from_thread_id FROM mail_thread_aliases a
      WHERE a.tenant_id = app_tenant_default() AND a.to_thread_id = $1::uuid))
ORDER BY d.email_item_id`;

/**
 * Trashes every unsent Semp draft (created and last edited by `agent`) whose source message is
 * older than `ownMessageDate`, and returns the retired item ids. Drafts the user edited, the draft
 * being sent, drafts held by an in-progress send, and drafts without a dated source stay.
 *
 * Retired as a discard (`trashLockedDraft`) by the system writer. The Emails item is locked before
 * the row, as every draft writer does, and the draft is re-read under the lock.
 */
export async function retireSupersededSempDrafts(
  client: PoolClient,
  input: RetireSupersededSempDraftsInput,
): Promise<string[]> {
  const ids = await resolveMailModuleIds(client);
  const { rows } = await client.query<Record<string, unknown>>(CANDIDATE_DRAFTS_SQL, [
    input.threadId,
    ids.emailsDatabaseId,
  ]);
  const ownTime = input.ownMessageDate.getTime();
  const superseded = rows
    .map((row) => candidateRow.parse(row))
    .filter((row) => row.emailItemId !== input.excludeDraftItemId)
    .filter((row) => {
      const sourceTime = row.sourceDate === null ? Number.NaN : Date.parse(row.sourceDate);
      return sourceTime < ownTime;
    });

  const queueAffinity = createActionQueueAffinity();
  const retired: string[] = [];
  for (const { emailItemId } of superseded) {
    const item = await lockItemById(client, ids.emailsDatabaseId, emailItemId);
    if (!item || item.deletedAt) continue;
    const draft = await getMailDraft(client, emailItemId, true);
    if (!draft || draft.createdBy !== "agent" || draft.lastEditedBy !== "agent" || draft.sentAt !== null) continue;
    // A draft that a send holds the claim of is being delivered: trashing it now would fail that send's finalization.
    if ((await getMailMessageMetaByItemId(client, emailItemId)) !== null) continue;
    await trashLockedDraft(client, ids, emailItemId, { writer: SYSTEM_WRITER, queueAffinity });
    retired.push(emailItemId);
  }
  if (retired.length > 0) announceMailThreadChanged(client, input.threadId);
  return retired;
}
