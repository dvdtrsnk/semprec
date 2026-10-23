import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the trash purge area (issue #1077). */
export const logger: Logger = createLogger("trash");
