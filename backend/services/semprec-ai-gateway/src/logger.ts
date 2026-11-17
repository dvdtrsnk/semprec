import { createLogger, type Logger } from "@semprec/shared";

/** This process's shared root logger. */
export const logger: Logger = createLogger("semprec-ai-gateway");
