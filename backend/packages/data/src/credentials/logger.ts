import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the external credentials area (issue #1062). */
export const logger: Logger = createLogger("credentials");
