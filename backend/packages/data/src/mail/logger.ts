import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the per-mailbox mail-sync process type (issue #166) — used wherever a mail-sync pass logs today, ahead of the standalone worker process a later issue stands up. */
export const logger: Logger = createLogger("mail-sync");
