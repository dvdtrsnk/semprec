import type { Pool } from "pg";
import {
  CORE_TASK_NAMES,
  ensureQueueSchema,
  grantQueueSchemaPrivileges,
  registerTask,
  runWorker,
  type TaskList,
} from "@semprec/queue";
import {
  assertTaskListMatchesAffinity,
  resolveTaskAffinitySets,
  LocalFsBlobStorageWriter,
  resolveBlobStorageDir,
  type BlobStorageWriter,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import type { AiGatewayClientPort } from "@semprec/shared";
import type { AudioGatewayClient } from "./audioGatewayClient.js";
import { createInboxAttachmentMetadataTask } from "./inboxAttachmentMetadata.js";
import { createInboxVoiceNoteTranscribeTask } from "./inboxVoiceNoteTranscribe.js";
import { createTranscriptCardRecomputeTask } from "./transcriptCardRecompute.js";
import { createTranscriptSpeakerSuggestionTask } from "./transcriptSpeakerSuggestionTask.js";
import { createTranscriptionCreateTask, createTranscriptionTask } from "./transcriptionTask.js";

export interface TranscribeQueueRuntime {
  stop(): Promise<void>;
}

type WorkerStarter = (options: Parameters<typeof runWorker>[0]) => Promise<{ stop(): Promise<void> }>;

/**
 * Four one-slot runners: the media pipeline, fast row creation, the short model tasks, and
 * attachment metadata (its ffmpeg runs can hold a slot up to the tools' timeouts), so no short kind
 * waits behind a long one. `blobStorage` defaults to the backend semprec-api writes Files blobs to.
 */
export async function createTranscribeQueueRuntime(
  pool: Pool,
  moduleRegistry: ModuleRegistry,
  blobStorage: BlobStorageWriter = new LocalFsBlobStorageWriter(resolveBlobStorageDir("FILES_STORAGE_DIR")),
  clients: { audio?: AudioGatewayClient; summary?: AiGatewayClientPort; startWorker?: WorkerStarter } = {},
): Promise<TranscribeQueueRuntime> {
  await ensureQueueSchema(pool);
  await grantQueueSchemaPrivileges(pool);
  const taskList: TaskList = {
    [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
      CORE_TASK_NAMES.TRANSCRIPTION_JOB,
      createTranscriptionTask(pool, blobStorage, clients.audio, clients.summary),
    ),
  };
  const createTaskList: TaskList = {
    [CORE_TASK_NAMES.TRANSCRIPTION_CREATE]: registerTask(
      CORE_TASK_NAMES.TRANSCRIPTION_CREATE,
      createTranscriptionCreateTask(pool),
    ),
  };
  const modelTaskList: TaskList = {
    [CORE_TASK_NAMES.TRANSCRIPT_CARD_RECOMPUTE]: registerTask(
      CORE_TASK_NAMES.TRANSCRIPT_CARD_RECOMPUTE,
      createTranscriptCardRecomputeTask(pool, clients.summary),
    ),
    [CORE_TASK_NAMES.TRANSCRIPT_SPEAKER_SUGGESTION]: registerTask(
      CORE_TASK_NAMES.TRANSCRIPT_SPEAKER_SUGGESTION,
      createTranscriptSpeakerSuggestionTask(pool, clients.summary),
    ),
    [CORE_TASK_NAMES.INBOX_VOICE_NOTE_TRANSCRIBE]: registerTask(
      CORE_TASK_NAMES.INBOX_VOICE_NOTE_TRANSCRIBE,
      createInboxVoiceNoteTranscribeTask(pool, blobStorage, clients.audio),
    ),
  };
  const mediaMetadataTaskList: TaskList = {
    [CORE_TASK_NAMES.INBOX_ATTACHMENT_METADATA]: registerTask(
      CORE_TASK_NAMES.INBOX_ATTACHMENT_METADATA,
      createInboxAttachmentMetadataTask(pool, blobStorage),
    ),
  };
  const affinitySets = await resolveTaskAffinitySets(moduleRegistry);
  assertTaskListMatchesAffinity(
    { ...taskList, ...createTaskList, ...modelTaskList, ...mediaMetadataTaskList },
    affinitySets.transcribe,
    "transcribe",
  );
  assertTaskListMatchesAffinity(taskList, new Set([CORE_TASK_NAMES.TRANSCRIPTION_JOB]), "transcribe");
  assertTaskListMatchesAffinity(createTaskList, new Set([CORE_TASK_NAMES.TRANSCRIPTION_CREATE]), "transcribe");
  assertTaskListMatchesAffinity(
    modelTaskList,
    new Set([
      CORE_TASK_NAMES.TRANSCRIPT_CARD_RECOMPUTE,
      CORE_TASK_NAMES.TRANSCRIPT_SPEAKER_SUGGESTION,
      CORE_TASK_NAMES.INBOX_VOICE_NOTE_TRANSCRIBE,
    ]),
    "transcribe",
  );
  assertTaskListMatchesAffinity(
    mediaMetadataTaskList,
    new Set([CORE_TASK_NAMES.INBOX_ATTACHMENT_METADATA]),
    "transcribe",
  );
  const startWorker = clients.startWorker ?? runWorker;
  // One ffmpeg/ASR pipeline per host: the TRANSCRIPTION_JOB handler is CPU- and disk-bound. Every runner takes one job at a time.
  const runners: Array<Awaited<ReturnType<WorkerStarter>>> = [];
  try {
    for (const list of [taskList, createTaskList, modelTaskList, mediaMetadataTaskList]) {
      runners.push(await startWorker({ pgPool: pool, taskList: list, noHandleSignals: true, concurrency: 1 }));
    }
  } catch (error) {
    const stopResults = await Promise.allSettled(runners.map((started) => started.stop()));
    const stopFailures = stopResults.flatMap((result) => {
      if (result.status !== "rejected") return [];
      const reason: unknown = result.reason;
      return [reason];
    });
    if (stopFailures.length > 0) {
      throw new AggregateError(
        [error, ...stopFailures],
        "Failed to start a transcription worker and stop the workers already started",
        { cause: error },
      );
    }
    throw error;
  }
  let stopped: Promise<void> | null = null;
  return {
    stop: () =>
      (stopped ??= Promise.allSettled(runners.map((started) => started.stop())).then((results) => {
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length > 0)
          throw new AggregateError(
            failures.map((failure) => {
              const reason: unknown = failure.reason;
              return reason;
            }),
            "Failed to stop transcription workers",
            { cause: failures[0]?.reason },
          );
      })),
  };
}
