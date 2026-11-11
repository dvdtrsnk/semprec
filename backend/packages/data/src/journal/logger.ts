import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the Journal module (issue #1726) — mirrors `trash/logger.ts`. */
export const logger: Logger = createLogger("journal");
