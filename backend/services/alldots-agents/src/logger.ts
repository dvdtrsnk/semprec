import { createLogger, type Logger } from "@alldots/shared";

/** This process's shared root logger. */
export const logger: Logger = createLogger("alldots-agents");
