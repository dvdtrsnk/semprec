import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the transcription process type (issue #166). */
export const logger: Logger = createLogger("transcribe");
