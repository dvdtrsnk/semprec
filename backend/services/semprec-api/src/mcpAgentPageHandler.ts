import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { withTransaction, ChokePointError, ValidationError, listMcpToolGrantsForProject, reclassifyMcpTool, setProjectMcpGrantForAgentPage } from "@semprec/data";
import type { Pool } from "pg";

export interface McpAgentPageHandlerOptions {
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
}

const MCP_GRANTS_PATH = /^\/api\/projects\/([^/]+)\/mcp-grants(?:\/([^/]+))?$/;
const MCP_TOOL_REGISTRATION_PATH = /^\/api\/mcp-tool-registrations\/([^/]+)$/;

/**
 * Handles the "Tools" block's HTTP surface on a project's AGENT page (issue #127):
 * - `GET /api/projects/:projectItemId/mcp-grants` — the block's read model (issue #124's
 *   active registrations across the whole system, joined with this project's grant).
 * - `PATCH /api/projects/:projectItemId/mcp-grants/:mcpToolRegistrationId` — toggles
 *   `project_mcp_grants.granted` for the exact project/tool pair, body `{ granted: boolean }`.
 * - `PATCH /api/mcp-tool-registrations/:id` — the minimal manual reclassification control,
 *   body `{ riskClass?: string, requiresApproval?: boolean }` (at least one required).
 *
 * These mutations reach `mcpGrantsAdminStore.ts`'s user-only functions only through
 * `@semprec/data`'s `mcpAgentPageGrants.ts` wrappers (see that file's header) — this handler
 * never imports the admin store directly, and couldn't: it's not re-exported from the package.
 *
 * Same stopgap shared-secret auth as `createAiUsageRequestListener` — see that file's comment
 * on `AiUsageHandlerOptions.authToken` for why this isn't a real session/credential yet.
 */
export function createMcpAgentPageRequestListener(pool: Pool, options: McpAgentPageHandlerOptions) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAuthorized(req, options.authToken)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      const grantsMatch = url.pathname.match(MCP_GRANTS_PATH);
      if (grantsMatch) {
        const [, projectItemId, mcpToolRegistrationId] = grantsMatch;

        if (req.method === "GET" && !mcpToolRegistrationId) {
          const rows = await withTransaction(pool, (client) => listMcpToolGrantsForProject(client, projectItemId));
          sendJson(res, 200, { rows });
          return;
        }

        if (req.method === "PATCH" && mcpToolRegistrationId) {
          const body = (await readJsonBody(req)) as { granted?: unknown };
          if (typeof body.granted !== "boolean") {
            sendJson(res, 400, { error: "'granted' must be a boolean" });
            return;
          }
          const grant = await withTransaction(pool, (client) =>
            setProjectMcpGrantForAgentPage(client, { projectItemId, mcpToolRegistrationId, granted: body.granted as boolean }),
          );
          sendJson(res, 200, grant);
          return;
        }

        sendJson(res, 404, { error: "Not found" });
        return;
      }

      const registrationMatch = url.pathname.match(MCP_TOOL_REGISTRATION_PATH);
      if (registrationMatch && req.method === "PATCH") {
        const [, mcpToolRegistrationId] = registrationMatch;
        const body = (await readJsonBody(req)) as { riskClass?: unknown; requiresApproval?: unknown };
        if (body.riskClass !== undefined && typeof body.riskClass !== "string") {
          sendJson(res, 400, { error: "'riskClass' must be a string" });
          return;
        }
        if (body.requiresApproval !== undefined && typeof body.requiresApproval !== "boolean") {
          sendJson(res, 400, { error: "'requiresApproval' must be a boolean" });
          return;
        }
        const registration = await withTransaction(pool, (client) =>
          reclassifyMcpTool(client, {
            mcpToolRegistrationId,
            riskClass: body.riskClass as string | undefined,
            requiresApproval: body.requiresApproval as boolean | undefined,
          }),
        );
        sendJson(res, 200, registration);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, { error: err.message, code: err.code, details: err.details });
        return;
      }
      console.error(`Unexpected error in ${req.method} ${url.pathname}:`, err);
      sendJson(res, 500, { error: "Internal server error" });
    }
  };
}
