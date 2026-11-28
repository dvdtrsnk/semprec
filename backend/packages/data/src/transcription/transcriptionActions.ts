import type { Pool } from "pg";
import { z } from "zod";
import { createLogger } from "@alldots/shared";
import { withTransaction } from "../db/pool.js";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import { withFromInbox } from "../chokePoint/itemOriginReads.js";
import * as blobsStore from "../blobs/blobsStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { listErroredItemAutomationForDatabases } from "../library/itemAutomationStore.js";
import { readRecordingRequest } from "./recordingIntake.js";
import {
  enqueueTranscriptionCreate,
  enqueueTranscriptionJob,
  readTranscriptionSourceFileItemId,
} from "./transcriptionJob.js";

export const FILES_TRANSCRIPTION_TRIGGER_ACTION_ID = "core.filesTranscriptionTrigger";
export const TRANSCRIPTION_REQUEUE_SWEEP_ACTION_ID = "core.transcriptionRequeueSweep";

/** 04:30 keeps it clear of the other daily heartbeats (03:05, 04:00). */
export const TRANSCRIPTION_REQUEUE_HEARTBEAT = {
  name: "Transcription requeue sweep",
  rule: { kind: "dailyTime", at: "04:30" },
} as const;

const logger = createLogger("transcription");

/** Relation property ids are stored by the seed, not re-resolved on every fire. */
const filesTranscriptionTriggerConfigSchema = z.object({
  filesDatabaseId: z.string().uuid(),
  attachmentsRelationPropertyId: z.string().uuid(),
  eventsRelationPropertyId: z.string().uuid(),
});

export function readBlobId(properties: Record<string, unknown>): string | undefined {
  const file = properties.file;
  if (typeof file !== "object" || file === null) return undefined;
  const blobId = (file as Record<string, unknown>).blobId;
  return typeof blobId === "string" ? blobId : undefined;
}

/**
 * `onItemEvent` ('create') action on Files: enqueues `transcriptionJob` for a standalone audio
 * recording and writes no item. A candidate is an `audio/*` blob with no Emails.attachments edge, no
 * Files.events edge and no Inbox origin (transcribing an Inbox file is proposed explicitly). Anything
 * else is silently skipped.
 */
export function createFilesTranscriptionTriggerAction(pool: Pool): ActionHandler {
  return async (actionConfig: Record<string, unknown>, context: ActionContext) => {
    if (!context.itemId) return; // only meaningful for an onItemEvent fire
    const itemId = context.itemId;
    const config = filesTranscriptionTriggerConfigSchema.parse(actionConfig);
    await withTransaction(pool, async (client) => {
      const fileItem = await itemsStore.lockItemById(client, config.filesDatabaseId, itemId);
      if (!fileItem) return;
      if (await readRecordingRequest(client, fileItem.id)) return;

      const [stamped] = await withFromInbox(client, [fileItem]);
      if (stamped?.fromInbox) return; // filed from an Inbox attachment, not a standalone recording

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

      const eventsDefinition = await relationsStore.getRelationDefinitionByPropertyId(
        client,
        config.eventsRelationPropertyId,
      );
      if (eventsDefinition) {
        const eventEdges = await relationsStore.listRelationsForItem(client, eventsDefinition.id, fileItem.id);
        if (eventEdges.length > 0) return; // an Event attachment, not a standalone recording
      }

      await enqueueTranscriptionCreate(client, { fileItemId: fileItem.id });
      await enqueueTranscriptionJob(client, { fileItemId: fileItem.id });
    });
  };
}

const transcriptionRequeueSweepConfigSchema = z.object({ transcriptsDatabaseId: z.string().uuid() });

/**
 * Daily sweep: re-enqueues every Transcripts row whose automation status is `error` as a fresh batch
 * under its original key `transcription-job:${fileItemId}`. The job resumes from its checkpoints, so
 * no second row is created and no paid stage repeats. The sweep writes nothing itself (never sets
 * `locked`), so a row is swept daily until it succeeds or a user locks it; re-enqueuing replaces a
 * still-queued job under the same key. A row whose `link` is not a Files link is skipped with a
 * warning.
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
