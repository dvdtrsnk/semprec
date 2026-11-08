import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the property-type migration job area (issue #1077). */
export const logger: Logger = createLogger("migration-job");
