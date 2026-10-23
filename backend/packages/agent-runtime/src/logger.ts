import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the agents process type (issue #166) — used wherever agent-runtime logs today, ahead of the standalone agent-runtime process a later issue stands up. */
export const logger: Logger = createLogger("agents");
