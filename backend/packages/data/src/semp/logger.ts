import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the Semp data modules that log outside a request. */
export const logger: Logger = createLogger("semp");
