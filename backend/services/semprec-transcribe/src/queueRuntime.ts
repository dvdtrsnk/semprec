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
import { createTranscriptionCreateTask, createTranscriptionTask } from "./transcriptionTask.js";

export interface TranscribeQueueRuntime {
  stop(): Promise<void>;
}

type WorkerStarter = (options: Parameters<typeof runWorker>[0]) => Promise<{ stop(): Promise<void> }>;

/** The sole graphile-worker registration site for `transcriptionJob`. `blobStorage` defaults to the same local-filesystem backend semprec-api writes Files blobs to, configured via `FILES_STORAGE_DIR`. */
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
  const affinitySets = await resolveTaskAffinitySets(moduleRegistry);
  assertTaskListMatchesAffinity({ ...taskList, ...createTaskList }, affinitySets.transcribe, "transcribe");
  assertTaskListMatchesAffinity(taskList, new Set([CORE_TASK_NAMES.TRANSCRIPTION_JOB]), "transcribe");
  assertTaskListMatchesAffinity(createTaskList, new Set([CORE_TASK_NAMES.TRANSCRIPTION_CREATE]), "transcribe");
  const startWorker = clients.startWorker ?? runWorker;
  const runner = await startWorker({
    pgPool: pool,
    taskList,
    noHandleSignals: true,
    // One ffmpeg/ASR pipeline per host: the TRANSCRIPTION_JOB handler is CPU- and disk-bound.
    concurrency: 1,
  });
  let createRunner: Awaited<ReturnType<WorkerStarter>>;
  try {
    createRunner = await startWorker({ pgPool: pool, taskList: createTaskList, noHandleSignals: true, concurrency: 1 });
  } catch (error) {
    let stopFailure: { error: unknown } | undefined;
    try {
      await runner.stop();
    } catch (cleanupError) {
      stopFailure = { error: cleanupError };
    }
    if (stopFailure) {
      throw new AggregateError(
        [error, stopFailure.error],
        "Failed to start transcription create worker and stop pipeline worker",
        { cause: error },
      );
    }
    throw error;
  }
  let stopped: Promise<void> | null = null;
  return {
    stop: () =>
      (stopped ??= Promise.allSettled([runner.stop(), createRunner.stop()]).then((results) => {
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
