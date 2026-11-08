import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import type { ItemRestoreHook } from "../chokePoint/hooks.js";
import { restoreItemWithClient } from "../chokePoint/itemTrash.js";
import { lockItemByIdNowait } from "../chokePoint/itemsStore.js";
import { FILES_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { readTranscriptionSourceFileItemId } from "./transcriptionJob.js";

/**
 * Restores a transcript's source Files item together with it (issue #1642): when a Transcripts row
 * is restored from the Trash, the Files item its `link` names is restored in the same transaction,
 * but only while that item is in the Trash with exactly the transcript's deletion epoch, i.e. it was
 * trashed together with it by `DELETE /api/transcripts/:id`. A source trashed on its own at another
 * instant stays in the Trash. Equal timestamps are not a transaction identity: a source trashed on
 * its own at exactly the same microsecond would be restored too.
 *
 * The restore cascade already holds the transcript's row lock, the opposite of the pipeline's
 * source-then-transcript order, so the source row is reserved with `FOR UPDATE NOWAIT`: a source
 * another transaction holds fails this restore with PostgreSQL's `55P03` (lock_not_available),
 * which rolls the whole restore back, instead of waiting for it while holding the transcript. See
 * docs/adr/2026-11-08-restore-hooks-carry-exact-deletion-epochs.md. The nested restore runs through
 * the choke point's own restore in this transaction, with the caller's queue routing and writer.
 */
export const transcriptRestoreHook: ItemRestoreHook = async (context) => {
  if (!context.database.system || context.database.ownerModuleId !== TRANSCRIPTS_MODULE_ID) return;
  const fileItemId = readTranscriptionSourceFileItemId(context.item.properties.link);
  if (!fileItemId) return;
  const files = await getDatabaseByModuleId(context.client, FILES_MODULE_ID);
  if (!files) return;
  const source = await lockItemByIdNowait(context.client, files.id, fileItemId);
  if (!source?.deletedAt) return;
  const { rows } = await context.client.query<{ same_epoch: boolean }>(
    "SELECT deleted_at = $3::timestamptz AS same_epoch FROM items WHERE database_id = $1 AND id = $2",
    [files.id, fileItemId, context.deletedAtExact],
  );
  if (rows[0]?.same_epoch !== true) return;
  await restoreItemWithClient(context.client, files.id, fileItemId, context.queueAffinity, context.actingUserId, {
    writerKind: context.writerKind,
    ...(context.agentRunId === undefined ? {} : { agentRunId: context.agentRunId }),
  });
};
