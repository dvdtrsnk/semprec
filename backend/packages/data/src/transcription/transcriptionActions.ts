import type { Pool } from "pg";
import { z } from "zod";
import { createLogger } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as blobsStore from "../blobs/blobsStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { listErroredItemAutomationForDatabases } from "../library/itemAutomationStore.js";
import { enqueueTranscriptionJob, readTranscriptionSourceFileItemId } from "./transcriptionJob.js";

export const FILES_TRANSCRIPTION_TRIGGER_ACTION_ID = "core.filesTranscriptionTrigger";
export const TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID = "core.transcriptionRequeueSweep";

const logger = createLogger("transcription");

/** The heartbeat's `action_config`: the Files database this action is scoped to, plus the Emails.attachments relation property to check a candidate file against — resolved once at seed time (seed/seedSystem.ts), not re-resolved on every fire. */
const filesTranscriptionTriggerConfigSchema = z.object({
  filesDatabaseId: z.string().uuid(),
  attachmentsRelationPropertyId: z.string().uuid(),
});

/** Shared with `transcriptionRouteHandlers.ts`'s own mime-type gate on `POST /api/transcriptions`. */
export function readBlobId(properties: Record<string, unknown>): string | undefined {
  const file = properties.file;
  if (typeof file !== "object" || file === null) return undefined;
  const blobId = (file as Record<string, unknown>).blobId;
  return typeof blobId === "string" ? blobId : undefined;
}

/**
 * Registered as an `onItemEvent` ('create') heartbeat action for the Files database (issue #180):
 * enqueues `TASK_NAMES.transcriptionJob` for a standalone audio recording, and does nothing else —
 * no item write, matching the issue's Task ("performing no item write"). A file is a candidate
 * only when its blob's mime type is `audio/*` and it carries no Emails.attachments edge (an
 * emailed audio attachment is not a standalone recording); everything else — a PDF, a video, a
 * mail attachment — is silently skipped, the same "not every create matters" shape as
 * `libraryMetadataActions.ts`'s trigger.
 */
export function createFilesTranscriptionTriggerAction(pool: Pool): ActionHandler {
  return async (actionConfig: Record<string, unknown>, context: ActionContext) => {
    if (!context.itemId) return; // only meaningful for an onItemEvent fire
    const config = filesTranscriptionTriggerConfigSchema.parse(actionConfig);
    await withTransaction(pool, async (client) => {
      const fileItem = await itemsStore.getItemById(client, config.filesDatabaseId, context.itemId as string);
      if (!fileItem) return; // deleted before the heartbeat fired

      const blobId = readBlobId(fileItem.properties);
      if (!blobId) return;
      const blob = await blobsStore.getBlob(client, blobId);
      if (!blob || !blob.mimeType.startsWith("audio/")) return;

      const attachmentsDefinition = await relationsStore.getRelationDefinitionByPropertyId(
        client,
        config.attachmentsRelationPropertyId,
      );
      if (attachmentsDefinition) {
        const attachmentEdges = await relationsStore.listRelationsForItem(
          client,
          attachmentsDefinition.id,
          fileItem.id,
        );
        if (attachmentEdges.length > 0) return; // an Emails attachment, not a standalone recording
      }

      await enqueueTranscriptionJob(client, { fileItemId: fileItem.id });
    });
  };
}

/** The requeue sweep's `action_config`: the Transcripts database whose failed rows it requeues, resolved once at seed time. */
const transcriptionRequeueSweepConfigSchema = z.object({ transcriptsDatabaseId: z.string().uuid() });

/**
 * Registered as a `dailyTime` heartbeat action (issue #186): re-enqueues every Transcriptions row
 * whose `item_automation.status` is `error` as a fresh 3-attempt batch under its original key,
 * `transcription-job:${fileItemId}`, with `fileItemId` read from the row's `link`. The job resumes
 * the existing row from its checkpoints, so no second row is created and no paid stage repeats.
 * Only `error` rows are listed — `done`, `pending` and `locked` ones are never touched — and the
 * sweep writes nothing itself, so it never sets `locked`; the row is swept again every day until
 * it succeeds or a user locks it. A repeat run while a batch is still queued replaces that job
 * under the same key rather than adding a second. A row whose `link` is not a Files item link
 * cannot be requeued: it is skipped with a warning so the rest of the sweep still runs.
 */
export function createTranscriptionRequeueSweepAction(pool: Pool): ActionHandler {
  return async (actionConfig: Record<string, unknown>) => {
    const config = transcriptionRequeueSweepConfigSchema.parse(actionConfig);
    await withTransaction(pool, async (client) => {
      const errored = await listErroredItemAutomationForDatabases(client, [config.transcriptsDatabaseId]);
      const transcripts = await itemsStore.getItemsByIds(
        client,
        errored.map((row) => row.itemId),
      );
      for (const transcript of transcripts) {
        const fileItemId = readTranscriptionSourceFileItemId(transcript.properties.link);
        if (!fileItemId) {
          logger.warn({ transcriptId: transcript.id }, "Skipping a failed transcription with no Files item link");
          continue;
        }
        await enqueueTranscriptionJob(client, { fileItemId });
      }
    });
  };
}
