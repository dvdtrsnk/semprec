import type { IncomingMessage, ServerResponse } from "node:http";
import { withTransaction, ChokePointError, ValidationError, getAgentRun, mintMcpRunCredential } from "@semprec/data";
import type { Pool } from "pg";
import { toPublicErrorBody } from "./adapter/errorContract.js";
import { assertUuid } from "./adapter/requestValidation.js";
import { PayloadTooLargeError, readJsonBody, sendJson } from "./adapter/http.js";
import { runInTenant } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { logger } from "./logger.js";

const MAX_BODY_BYTES = 64 * 1024;

const AGENT_RUN_PATH = /^\/api\/agent-runs\/([^/]+)$/;
const MCP_CREDENTIALS_PATH = "/api/agent-runs/mcp-credentials";

interface MintMcpCredentialRequestBody {
  projectItemId?: unknown;
  capabilities?: unknown;
  task?: unknown;
}

function parseMintMcpCredentialBody(body: unknown): { projectItemId: string; capabilities: string[]; task?: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const parsed = body as MintMcpCredentialRequestBody;
  if (typeof parsed.projectItemId !== "string" || parsed.projectItemId.length === 0) {
    throw new ValidationError("'projectItemId' must be a non-empty string");
  }
  if (!Array.isArray(parsed.capabilities) || !parsed.capabilities.every((c): c is string => typeof c === "string")) {
    throw new ValidationError("'capabilities' must be an array of strings");
  }
  if (parsed.task !== undefined && typeof parsed.task !== "string") {
    throw new ValidationError("'task' must be a string when present");
  }
  return { projectItemId: parsed.projectItemId, capabilities: parsed.capabilities, task: parsed.task };
}

/**
 * `GET /api/agent-runs/:id` — the destination the global approval queue's (issue #132) "source
 * agent-run link" points at — a read-only view of one run's task, status, result and timestamps,
 * backed by the already-existing `getAgentRun`.
 *
 * `POST /api/agent-runs/mcp-credentials` (issue #220, AC34/44/47) mints a restricted, single-run
 * `agent_run` plus an opaque credential for it (`mintMcpRunCredential`) — the piece that lets an
 * MCP actor (`POST /mcp`) later prove which run it acts for, and be restricted to an explicit
 * capability subset, instead of every session sharing the fixed process-wide grant. The minted
 * token is returned exactly once, in this response; only its hash is ever persisted.
 *
 * Both routes are gated by `authenticateRequest` (issue #143), same session middleware
 * `authHandler.ts` uses — minting a credential still requires an already-authenticated human
 * session, same as every other write this handler makes.
 */
export function createAgentRunRequestListener(pool: Pool) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      const identity = await authenticateRequest(pool, req);

      await runInTenant(identity.tenantId, async () => {
        if (url.pathname === MCP_CREDENTIALS_PATH) {
          if (req.method !== "POST") {
            sendJson(res, 404, { error: "Not found" });
            return;
          }

          let body: unknown;
          try {
            body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
          } catch (err) {
            if (err instanceof PayloadTooLargeError) {
              sendJson(res, 413, { error: err.message });
              return;
            }
            throw err;
          }

          const input = parseMintMcpCredentialBody(body);
          const minted = await withTransaction(pool, (client) =>
            mintMcpRunCredential(client, { ...input, userId: identity.user.id }),
          );
          sendJson(res, 201, {
            runId: minted.run.id,
            agentProjectItemId: input.projectItemId,
            token: minted.token,
            capabilities: minted.capabilities,
            expiresAt: minted.expiresAt,
          });
          return;
        }

        const match = url.pathname.match(AGENT_RUN_PATH);
        if (!match || req.method !== "GET") {
          sendJson(res, 404, { error: "Not found" });
          return;
        }

        // Group 1 of the route pattern above is not optional, so a successful match always
        // captured it; a runtime check here would be unreachable code.
        const agentRunId = assertUuid(match[1]!, "id");
        const run = await withTransaction(pool, (client) => getAgentRun(client, agentRunId));
        if (!run) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }
        sendJson(res, 200, run);
      });
    } catch (err) {
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, toPublicErrorBody(err));
        return;
      }
      logger.error({ err, method: req.method, path: url.pathname }, "Unexpected error handling request");
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
      logger.error({ err }, "Unhandled error in the request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
