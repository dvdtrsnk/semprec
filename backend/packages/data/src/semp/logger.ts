import { createLogger, type Logger } from "@alldots/shared";

/** Named root logger for the Semp data modules that log outside a request. */
export const logger: Logger = createLogger("semp");
