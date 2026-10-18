import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the blob upload storage area (issue #1077). */
export const logger: Logger = createLogger("blobs");
