import type { IncomingMessage, ServerResponse } from "node:http";
import { withTransaction, ChokePointError, getAgentRun } from "@semprec/data";
import type { Pool } from "pg";
import { authenticateRequest } from "./authHandler.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

const AGENT_RUN_PATH = /^\/api\/agent-runs\/([^/]+)$/;

/**
 * A single agent run's detail: `GET /api/agent-runs/:id`. This is the destination the global
 * approval queue's (issue #132) "source agent-run link" points at — a read-only view of one
 * run's task, status, result and timestamps, backed by the already-existing `getAgentRun`.
 *
 * Gated by `authenticateRequest` (issue #143), same session middleware `authHandler.ts` uses.
 */
export function createAgentRunRequestListener(pool: Pool) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      await authenticateRequest(pool, req);

      const match = url.pathname.match(AGENT_RUN_PATH);
      if (!match || req.method !== "GET") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      // Group 1 of the route pattern above is not optional, so a successful match always
      // captured it; a runtime check here would be unreachable code.
      const agentRunId = match[1]!;
      const run = await withTransaction(pool, (client) => getAgentRun(client, agentRunId));
      if (!run) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      sendJson(res, 200, run);
    } catch (err) {
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, { error: err.message, code: err.code, details: err.details });
        return;
      }
      console.error(`Unexpected error in ${req.method} ${url.pathname}:`, err);
      sendJson(res, 500, { error: "Internal server error" });
    }
  }

  /**
   * `http.createServer` discards its listener's return value, so an `async` listener turns any
   * rejection escaping the try/catch above into an unhandled rejection — which Node answers by
   * exiting the process. Keeping the boundary synchronous confines it to a 500 for the one
   * request. Same shape as `setupHandler.ts`.
   */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      console.error("Unhandled error in the request listener:", err);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
