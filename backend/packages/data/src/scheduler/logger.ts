import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the heartbeat scheduler sweep area (issue #1077). */
export const logger: Logger = createLogger("scheduler");
