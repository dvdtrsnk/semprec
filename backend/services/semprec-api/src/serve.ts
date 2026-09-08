import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createPool } from "@semprec/data";
import { createAiUsageRequestListener } from "./aiUsageHandler.js";
import { createMcpAgentPageRequestListener } from "./mcpAgentPageHandler.js";
import { createApprovalRequestsRequestListener } from "./approvalRequestsHandler.js";
import { createAgentRunRequestListener } from "./agentRunHandler.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const authToken = process.env.SEMPREC_API_TOKEN;
if (!authToken) throw new Error("SEMPREC_API_TOKEN is not set");

const rawPort = process.env.PORT ?? "3001";
const port = Number(rawPort);
if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT is not a valid port number: ${rawPort}`);

const pool = createPool(connectionString);
const aiUsageListener = createAiUsageRequestListener(pool, { authToken });
const mcpAgentPageListener = createMcpAgentPageRequestListener(pool, { authToken });
const approvalRequestsListener = createApprovalRequestsRequestListener(pool, { authToken });
const agentRunListener = createAgentRunRequestListener(pool, { authToken });

/** Routes by path prefix; `mcpAgentPageListener` already answers 404 itself for anything else. */
function dispatch(req: IncomingMessage, res: ServerResponse): void {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === "/api/ai-usage") {
    void aiUsageListener(req, res);
    return;
  }
  if (pathname === "/api/approval-requests" || pathname.startsWith("/api/approval-requests/")) {
    void approvalRequestsListener(req, res);
    return;
  }
  if (pathname.startsWith("/api/agent-runs/")) {
    void agentRunListener(req, res);
    return;
  }
  void mcpAgentPageListener(req, res);
}

const server = createServer(dispatch);

server.listen(port, () => {
  console.log(`semprec-api listening on port ${port}`);
});
