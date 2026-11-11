import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the calendar module (issue #1717), like `journal/logger.ts`. */
export const logger: Logger = createLogger("calendar");
