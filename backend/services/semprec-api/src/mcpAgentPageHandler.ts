import type { IncomingMessage, ServerResponse } from "node:http";
import {
  withTransaction,
  ChokePointError,
  countEffectiveMcpGrants,
  listMcpToolGrantsForProject,
  McpConnectionError,
  type McpToolDisplayLabel,
  reclassifyMcpTool,
  setProjectMcpGrantForAgentPage,
  suggestMcpToolLabels,
  syncMcpServerTools,
} from "@semprec/data";
import type { Pool } from "pg";
import { toPublicErrorBody } from "./adapter/errorContract.js";
import { assertUuid } from "./adapter/requestValidation.js";
import { PayloadTooLargeError, readJsonBody, sendJson } from "./adapter/http.js";
import { runInTenant, type AiGatewayClientPort } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { logger } from "./logger.js";

const MAX_BODY_BYTES = 1 * 1024 * 1024;

const MCP_GRANTS_PATH = /^\/api\/projects\/([^/]+)\/mcp-grants(?:\/([^/]+))?$/;
const MCP_TOOL_REGISTRATION_PATH = /^\/api\/mcp-tool-registrations\/([^/]+)$/;
const MCP_SERVER_SYNC_PATH = /^\/api\/mcp-servers\/([^/]+)\/sync$/;

/**
 * Handles the "Tools" block's HTTP surface on a project's AGENT page (issue #127):
 * - `GET /api/projects/:projectItemId/mcp-grants` — the block's read model (issue #124's
 *   active registrations across the whole system, joined with this project's grant).
 * - `PATCH /api/projects/:projectItemId/mcp-grants/:mcpToolRegistrationId` — toggles
 *   `project_mcp_grants.granted` for the exact project/tool pair, body `{ granted: boolean }`.
 * - `PATCH /api/mcp-tool-registrations/:id` — the minimal manual reclassification control,
 *   body `{ riskClass?: string, requiresApproval?: boolean, displayLabel?: { cs?, en? } | null }`
 *   (at least one required; `null` clears the label).
 * - `POST /api/mcp-servers/:id/sync` — runs `syncMcpServerTools` inline for one MCP server of the caller's
 *   tenant and answers `{ toolCount, syncStatus: "ok" }`. A connection failure answers 502
 *   `{ error, reason }` with the typed `McpConnectionError` reason and nothing else of the failure; a tool-list
 *   validation failure keeps its 400. `syncMcpServerTools` has already recorded `syncStatus: "error"` on the
 *   server item in both cases. An unknown id, or one of another tenant, answers the same 404. After a sync that
 *   succeeded, and before the answer, it asks the gateway for labels of the server's tools that have none
 *   (`suggestMcpToolLabels`, issue gh-1983); that step never changes the answer, and is skipped when the listener
 *   was created without a gateway client.
 *
 * The grant and reclassification mutations reach `mcpGrantsAdminStore.ts`'s user-only functions only through
 * `@semprec/data`'s `mcpAgentPageGrants.ts` wrappers (see that file's header) — this handler
 * never imports the admin store directly, and couldn't: it's not re-exported from the package. The sync route
 * does not touch the admin store: it calls `syncMcpServerTools` from `@semprec/data` directly.
 *
 * Gated by `authenticateRequest` (issue #143), same session middleware `authHandler.ts` uses.
 */
export function createMcpAgentPageRequestListener(pool: Pool, gateway?: AiGatewayClientPort) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      const identity = await authenticateRequest(pool, req);

      await runInTenant(identity.tenantId, async () => {
        const grantsMatch = url.pathname.match(MCP_GRANTS_PATH);
        if (grantsMatch) {
          // Group 1 of MCP_GRANTS_PATH is mandatory; group 2 is genuinely optional and the
          // branches below distinguish on it, so it keeps its `string | undefined` type.
          const projectItemId = assertUuid(grantsMatch[1]!, "id");
          const mcpToolRegistrationId =
            grantsMatch[2] === undefined ? undefined : assertUuid(grantsMatch[2], "mcpToolRegistrationId");

          if (req.method === "GET" && !mcpToolRegistrationId) {
            const rows = await withTransaction(pool, (client) =>
              listMcpToolGrantsForProject(client, projectItemId, identity.user.locale),
            );
            sendJson(res, 200, { rows, counts: countEffectiveMcpGrants(rows) });
            return;
          }

          if (req.method === "PATCH" && mcpToolRegistrationId) {
            const body = (await readJsonBody(req, { maxBytes: MAX_BODY_BYTES })) as { granted?: unknown };
            if (typeof body.granted !== "boolean") {
              sendJson(res, 400, { error: "'granted' must be a boolean" });
              return;
            }
            const grant = await withTransaction(pool, (client) =>
              setProjectMcpGrantForAgentPage(client, {
                projectItemId,
                mcpToolRegistrationId,
                granted: body.granted as boolean,
              }),
            );
            sendJson(res, 200, grant);
            return;
          }

          sendJson(res, 404, { error: "Not found" });
          return;
        }

        const registrationMatch = url.pathname.match(MCP_TOOL_REGISTRATION_PATH);
        if (registrationMatch && req.method === "PATCH") {
          // Group 1 of MCP_TOOL_REGISTRATION_PATH is not optional — see above.
          const mcpToolRegistrationId = assertUuid(registrationMatch[1]!, "mcpToolRegistrationId");
          const body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
          if (body === null || typeof body !== "object" || Array.isArray(body)) {
            sendJson(res, 400, { error: "Request body must be an object" });
            return;
          }
          const riskClass = "riskClass" in body ? body.riskClass : undefined;
          const requiresApproval = "requiresApproval" in body ? body.requiresApproval : undefined;
          const rawLabel = "displayLabel" in body ? body.displayLabel : undefined;
          if (riskClass !== undefined && typeof riskClass !== "string") {
            sendJson(res, 400, { error: "'riskClass' must be a string" });
            return;
          }
          if (requiresApproval !== undefined && typeof requiresApproval !== "boolean") {
            sendJson(res, 400, { error: "'requiresApproval' must be a boolean" });
            return;
          }
          if (
            rawLabel !== undefined &&
            rawLabel !== null &&
            (typeof rawLabel !== "object" || Array.isArray(rawLabel))
          ) {
            sendJson(res, 400, { error: "'displayLabel' must be an object or null" });
            return;
          }
          let displayLabel: McpToolDisplayLabel | null | undefined;
          if (rawLabel === null) displayLabel = null;
          else if (rawLabel !== undefined) {
            displayLabel = {};
            for (const [key, value] of Object.entries(rawLabel)) {
              if (key !== "cs" && key !== "en") {
                sendJson(res, 400, {
                  error: "'displayLabel' has an unknown key; allowed keys are 'cs' and 'en'",
                });
                return;
              }
              if (typeof value !== "string") {
                sendJson(res, 400, { error: `'displayLabel.${key}' must be a string` });
                return;
              }
              displayLabel[key] = value;
            }
          }
          const registration = await withTransaction(pool, (client) =>
            reclassifyMcpTool(client, {
              mcpToolRegistrationId,
              riskClass,
              requiresApproval,
              displayLabel,
            }),
          );
          sendJson(res, 200, registration);
          return;
        }

        const syncMatch = url.pathname.match(MCP_SERVER_SYNC_PATH);
        if (syncMatch && req.method === "POST") {
          // Group 1 of MCP_SERVER_SYNC_PATH is not optional — see above.
          const mcpServerItemId = assertUuid(syncMatch[1]!, "id");
          const { toolCount } = await syncMcpServerTools(pool, mcpServerItemId, { actorId: identity.user.id });
          if (gateway) await suggestMcpToolLabels(pool, gateway, mcpServerItemId);
          sendJson(res, 200, { toolCount, syncStatus: "ok" });
          return;
        }

        sendJson(res, 404, { error: "Not found" });
      });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      if (err instanceof McpConnectionError) {
        // Fixed wording plus the typed reason: the error's own message and the server's answer stay out of the body.
        sendJson(res, 502, { error: "Could not connect to the MCP server", reason: err.reason });
        return;
      }
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, toPublicErrorBody(err));
        return;
      }
      logger.error(
        { errName: err instanceof Error ? err.name : typeof err, method: req.method },
        "Unexpected error handling request",
      );
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
      logger.error(
        { errName: err instanceof Error ? err.name : typeof err },
        "Unhandled error in the request listener",
      );
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
