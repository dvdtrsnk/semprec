// Retires the Semp drafts a message of the user's own makes outdated (issue gh-1902). Called inside the transaction
// that finalizes a send (mail/send.ts) and inside the one that ingests a message of the user's own (mail/ingest.ts).
// Constrained by: docs/adr/2026-11-13-a-discarded-mail-draft-loses-its-row-and-draft-writers-lock-the-item-before-the-row.md,
// docs/adr/2026-11-14-retiring-an-outdated-semp-draft-takes-the-steps-of-a-discard-as-the-system.md
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
  /** The thread of the user's own message. */
  threadId: string;
  /** When the user's own message was sent or dated. */
  ownMessageDate: Date;
  /** The draft that is being sent, which stays; absent when the message is not a draft of Semprec's. */
  excludeDraftItemId?: string;
}

const candidateRow = z.object({ emailItemId: z.uuid(), sourceDate: z.string().nullable() });

/**
 * The unsent agent drafts of a thread, with the `date` of their source message. A draft belongs to the thread its
 * `thread_id` names and, once that thread was merged away, to the thread that absorbed it (`mail_thread_aliases`;
 * `reassignThread` does not re-point `mail_drafts.thread_id`), so the thread's own id and the ids merged into it are
 * both matched. Only drafts whose Emails item is not in the trash are listed, and only those with a source message
 * that is an Emails item. Fixed SQL; the parameters are ids.
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
 * Soft-deletes every unsent Semp draft of thread `input.threadId` whose source message is older than
 * `input.ownMessageDate`, in the caller's transaction and tenant, and answers the item ids it retired. A Semp draft is
 * a draft with `created_by` `agent` and `last_edited_by` `agent`: a draft of the user stays, and so does a Semp draft
 * the user has worked on (edited its text or recipients, or attached or removed a file), because the issue leaves
 * retiring drafts the user edited out of scope and their work is not ours to remove. The draft in
 * `input.excludeDraftItemId` stays, a draft that holds the claim of a send in progress stays (its send is delivering
 * it), and so does a draft that has no source message or whose source has no readable `date`, because nothing says
 * the user's message answers it. A draft whose source is as new as the user's message or newer is an answer to something the
 * user has not replied to, and stays.
 *
 * Each draft is retired as a discard is (`trashLockedDraft`): its Emails item goes to the trash through the choke
 * point and its `mail_drafts` row is deleted, so the thread no longer has a Semp draft (`hasSempDraft`) and can get a
 * new one. The writer is the system's: the user's message is the cause, not an edit of the draft. The Emails item
 * is locked before the row, as every draft writer does, and the draft is read again under the locks: one the user sent
 * or discarded since the listing stays as that left it.
 *
 * When it retired a draft it announces the thread after the commit, as a draft discard does; a caller that announces
 * the same thread for its own reason adds a second, identical announcement.
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
