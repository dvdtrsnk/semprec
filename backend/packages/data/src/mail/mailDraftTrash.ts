// The writes that take a Semprec mail draft out of use, shared by the discard route's operation (mail/draft.ts, issue
// gh-1867) and the retirement of an outdated Semp draft (mail/draftRetirement.ts, issue gh-1902).
// Constrained by: docs/adr/2026-11-13-a-discarded-mail-draft-loses-its-row-and-draft-writers-lock-the-item-before-the-row.md
import type { PoolClient } from "pg";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import type { ActionQueueAffinity } from "../scheduler/actions.js";
import { deleteFilesOfDiscardedDraft } from "./mailDraftAttachmentFiles.js";
import { deleteMailDraft } from "./mailDraftsStore.js";
import type { MailModuleIds } from "./mailModuleIds.js";

/**
 * The writes that take a draft out of use, for a draft whose Emails item and `mail_drafts` row the caller holds
 * locked, the item first and then the row: the files attached to it that were made for it and belong to it alone go to the trash
 * (`deleteFilesOfDiscardedDraft`, issue gh-1895; a file that is older than the draft stays), the Emails item goes to
 * the trash and its `mail_drafts` row is deleted, which frees the thread for a new agent draft
 * ([[2026-11-13-a-discarded-mail-draft-loses-its-row-and-draft-writers-lock-the-item-before-the-row]]). It announces
 * nothing; the caller does.
 */
export async function trashLockedDraft(
  client: PoolClient,
  ids: MailModuleIds,
  draftItemId: string,
  options: { writer: WriterIdentity; actingUserId?: string; queueAffinity: ActionQueueAffinity },
): Promise<void> {
  await deleteFilesOfDiscardedDraft(client, ids, draftItemId, options);
  const trashed = await itemDeleteWithClient(client, ids.emailsDatabaseId, draftItemId, options);
  // The item is locked and was live a statement ago, so the trash finds it.
  if (trashed === null) throw new Error(`Draft ${draftItemId} disappeared while it was discarded`);
  await deleteMailDraft(client, draftItemId);
}
