import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the queue package. */
export const logger: Logger = createLogger("queue");
