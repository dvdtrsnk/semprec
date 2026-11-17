import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import type { ItemRestoreHook } from "../chokePoint/hooks.js";
import { restoreItemWithClient } from "../chokePoint/itemTrash.js";
import { lockItemByIdNowait } from "../chokePoint/itemsStore.js";
import { FILES_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { readTranscriptionSourceFileItemId } from "./transcriptionJob.js";

/**
 * Restores a transcript's source Files item with it, but only while that item is trashed with exactly
 * the transcript's deletion epoch (trashed together by `DELETE /api/transcripts/:id`). A source trashed
 * on its own at the same microsecond would be restored too: timestamps are not transaction identity.
 *
 * The restore cascade already holds the transcript's row lock, the opposite of the pipeline's
 * source-then-transcript order, so the source is reserved with `FOR UPDATE NOWAIT`: a contended source
 * fails the restore with `55P03` instead of waiting while holding the transcript.
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
