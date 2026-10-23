import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the database layer (issue #704) — mirrors `mail/logger.ts`. */
export const logger: Logger = createLogger("db");
