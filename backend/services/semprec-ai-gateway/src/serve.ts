import { createServer } from "node:http";
import { createPool } from "@semprec/data";
import { createDispatcher } from "./app.js";
import { resolveStartupConfig } from "./startupConfig.js";

const config = resolveStartupConfig(process.env);

const pool = createPool(config.databaseUrl);
const dispatch = createDispatcher(pool, config.handlerOptions);

const server = createServer(dispatch);

server.listen(config.port, () => {
  console.log(`semprec-ai-gateway listening on port ${config.port}`);
});
