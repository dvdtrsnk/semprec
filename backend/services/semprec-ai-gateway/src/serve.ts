import { createServer } from "node:http";
import { createPool } from "@semprec/data";
import { installFatalHandlers } from "@semprec/shared";
import { createDispatcher } from "./app.js";
import { resolveStartupConfig } from "./startupConfig.js";
import { logger } from "./logger.js";

installFatalHandlers(logger);

const config = resolveStartupConfig(process.env);

const pool = createPool(config.databaseUrl);
const dispatch = createDispatcher(pool, config.handlerOptions);

const server = createServer(dispatch);

server.listen(config.port, () => {
  logger.info({ port: config.port }, "semprec-ai-gateway listening");
});
