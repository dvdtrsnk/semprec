import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for tenant-level system work (the per-tenant fan-out). */
export const logger: Logger = createLogger("tenancy");
