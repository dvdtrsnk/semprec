import type { PoolClient } from "pg";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import type { ActionQueueAffinity } from "../scheduler/actions.js";
import { deleteFilesOfDiscardedDraft } from "./mailDraftAttachmentFiles.js";
import { deleteMailDraft } from "./mailDraftsStore.js";
import type { MailModuleIds } from "./mailModuleIds.js";

/**
 * Takes a draft out of use; the caller holds its Emails item and then its `mail_drafts` row locked. Trashes the files
 * that belong to this draft alone (an older file stays), trashes the item and deletes the row, which frees the thread
 * for a new agent draft. Announces nothing; the caller does.
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
