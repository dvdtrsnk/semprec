import { createLogger, type Logger } from "@alldots/shared";

/** Named root logger for the queue package. */
export const logger: Logger = createLogger("queue");
