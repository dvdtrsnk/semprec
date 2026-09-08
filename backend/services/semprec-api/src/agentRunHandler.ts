import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { withTransaction, ChokePointError, getAgentRun } from "@semprec/data";
import type { Pool } from "pg";

export interface AgentRunHandlerOptions {
  /** Same stopgap shared-secret bearer token as `aiUsageHandler.ts` — see that file's comment. */
  authToken: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

/** Constant-time so a network caller can't recover the token byte-by-byte from response timing. */
function isAuthorized(req: IncomingMessage, authToken: string): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(authToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

const AGENT_RUN_PATH = /^\/api\/agent-runs\/([^/]+)$/;

/**
 * A single agent run's detail: `GET /api/agent-runs/:id`. This is the destination the global
 * approval queue's (issue #132) "source agent-run link" points at — a read-only view of one
 * run's task, status, result and timestamps, backed by the already-existing `getAgentRun`.
 */
export function createAgentRunRequestListener(pool: Pool, options: AgentRunHandlerOptions) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAuthorized(req, options.authToken)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    try {
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
   * request. Same shape as `aiUsageHandler.ts`.
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
