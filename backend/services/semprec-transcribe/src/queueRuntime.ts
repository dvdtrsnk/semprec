import type { Pool } from "pg";
import {
  CORE_TASK_NAMES,
  ensureQueueSchema,
  grantQueueSchemaPrivileges,
  registerTask,
  runWorker,
  type TaskList,
} from "@semprec/queue";
import { createTranscriptionTask } from "./transcriptionTask.js";

export interface TranscribeQueueRuntime {
  stop(): Promise<void>;
}

/** The sole graphile-worker registration site for `transcriptionJob`. */
export async function createTranscribeQueueRuntime(pool: Pool): Promise<TranscribeQueueRuntime> {
  await ensureQueueSchema(pool);
  await grantQueueSchemaPrivileges(pool);
  const taskList: TaskList = {
    [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(CORE_TASK_NAMES.TRANSCRIPTION_JOB, createTranscriptionTask(pool)),
  };
  const runner = await runWorker({ pgPool: pool, taskList, noHandleSignals: true });
  let stopped: Promise<void> | null = null;
  return { stop: () => (stopped ??= runner.stop()) };
}
