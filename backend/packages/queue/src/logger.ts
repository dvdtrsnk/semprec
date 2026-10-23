import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the queue package itself (registerTask's supersession-detection path). */
export const logger: Logger = createLogger("queue");
