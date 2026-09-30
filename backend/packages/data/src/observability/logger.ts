import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the observability process type (issue #706), same pattern as `mail/logger.ts`. */
export const logger: Logger = createLogger("observability");
