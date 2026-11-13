import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for global search (issue #1842), like `journal/logger.ts`. */
export const logger: Logger = createLogger("search");
