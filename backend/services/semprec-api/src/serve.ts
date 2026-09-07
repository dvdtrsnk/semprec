import { createServer } from "node:http";
import { createPool } from "@semprec/data";
import { createAiUsageRequestListener } from "./aiUsageHandler.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const authToken = process.env.SEMPREC_API_TOKEN;
if (!authToken) throw new Error("SEMPREC_API_TOKEN is not set");

const rawPort = process.env.PORT ?? "3001";
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT is not a valid port number: ${rawPort}`);

const pool = createPool(connectionString);
const server = createServer(createAiUsageRequestListener(pool, { authToken }));

server.listen(port, () => {
  console.log(`semprec-api listening on port ${port}`);
});
