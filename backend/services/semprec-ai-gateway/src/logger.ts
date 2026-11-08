import { createLogger, type Logger } from "@semprec/shared";

/** This process's shared root logger (issue #166) — every handler in this service logs through it. */
export const logger: Logger = createLogger("semprec-ai-gateway");
