import { createLogger, type Logger } from "@semprec/shared";

/** Named root logger for the MCP server sync area (issue #1077). */
export const logger: Logger = createLogger("mcp");
