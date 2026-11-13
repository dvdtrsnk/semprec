import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  ApprovalRequiredError,
  ChokePointError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  resolveModuleAgentToolsForRun,
  setAgentRunMcpClientName,
  withTransaction,
} from "@semprec/data";
import {
  GENERIC_OPERATION_NAMES,
  operationInputJsonSchema,
  runInTenant,
  type AuthenticatedActor,
  type CapabilityId,
  type GenericOperationName,
} from "@semprec/shared";
import type { ModuleRegistry } from "@semprec/module-registry";
import type { GenericOperationGateway } from "@semprec/application";
import { toPublicErrorBody } from "../adapter/errorContract.js";
import { extractBearerToken, PayloadTooLargeError, readJsonBody, sendJson } from "../adapter/http.js";
import { authenticateRequest } from "../authHandler.js";
import { resolveRunCredentialCaller } from "./callerActor.js";
import { logger } from "../logger.js";

/** MCP protocol revisions `initialize` can agree on, newest first; the first is the fallback. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** The API service's own package version, reported as `serverInfo.version`. */
const SERVER_VERSION = (() => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string") throw new Error("semprec-api package.json has no version string");
  return manifest.version;
})();

const MCP_TOOL_PREFIX = "semprec.";

function toMcpToolName(operation: GenericOperationName): string {
  return `${MCP_TOOL_PREFIX}${operation}`;
}

function fromMcpToolName(name: string): GenericOperationName | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const operation = name.slice(MCP_TOOL_PREFIX.length);
  return (GENERIC_OPERATION_NAMES as readonly string[]).includes(operation)
    ? (operation as GenericOperationName)
    : null;
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } };
}

const MAX_BODY_BYTES = 1 * 1024 * 1024;

interface JsonRpcRequestBody {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** The `name` of an `initialize` request's `clientInfo` when it is a string, otherwise `null`. */
function readClientName(clientInfo: unknown): string | null {
  if (typeof clientInfo !== "object" || clientInfo === null) return null;
  const name: unknown = "name" in clientInfo ? clientInfo.name : undefined;
  return typeof name === "string" ? name : null;
}

/**
 * The authenticated MCP JSON-RPC endpoint (issue #220): `POST /mcp`, `initialize`, `tools/list` and
 * `tools/call` over the same 44-operation generic catalog REST (#219) and the AgentTool
 * composition root (`packages/agent-runtime/src/tools/generic`) dispatch through — MCP names are
 * the operation names prefixed `semprec.` (`fromMcpToolName`/`toMcpToolName`). The gateway neither
 * lists nor calls the catalog's REST-only operations (`REST_ONLY_OPERATION_NAMES`, issue #1699) for a
 * caller of this endpoint; the assistant will propose a new select option on an Inbox proposal
 * instead (#1994).
 *
 * A request with no bearer token is rejected with `UnauthorizedError` before any session lookup
 * runs — the web session cookie is never consulted, even though `authenticateRequest` would
 * otherwise accept it (`extractBearerToken`'s docstring).
 *
 * Given a bearer token, the actor is derived one of two ways, tried in this order (AC34/44/47):
 *  1. A restricted MCP run-credential (`resolveMcpRunCredential`, minted via
 *     `POST /api/agent-runs/mcp-credentials`): resolves to `{ userId, runId, agentProjectItemId }`,
 *     so `gateway.invoke`'s approval gate actually applies, and the operations it can see are
 *     further restricted to the credential's own granted capability subset.
 *  2. `authenticateRequest`'s verified human session/Bearer identity: `{ userId, externalClient: true }`, no
 *     `runId`, so the approval gate stays a no-op for it, same as REST. The marker is an external AI client
 *     (issue #1998): the data layer refuses it every sensitive database, which a REST call of the same user
 *     still reads.
 * Either way, an ungranted or unknown tool name resolve to the same JSON-RPC "method not found"
 * rather than a distinguishable error, per the issue's "never present-but-forbidden" requirement.
 *
 * `grantedCapabilities` is fixed per process (the schema core module's own registered
 * capabilities — see `schemaCoreModuleManifest.ts`); a restricted credential's own capability list
 * is intersected against it, so a credential can only ever narrow what a process already grants,
 * never widen it.
 */
export async function createMcpRequestListener(
  pool: Pool,
  gateway: GenericOperationGateway,
  grantedCapabilities: ReadonlySet<CapabilityId>,
  registry: ModuleRegistry,
) {
  const activeNames = await registry.getActiveAgentToolNames();
  const collision = activeNames.find((name) => (GENERIC_OPERATION_NAMES as readonly string[]).includes(name));
  if (collision) throw new Error(`Module tool collides with generic operation: ${collision}`);
  async function resolveActor(
    req: IncomingMessage,
  ): Promise<{ actor: AuthenticatedActor; capabilities: ReadonlySet<CapabilityId>; tenantId: string }> {
    const bearerToken = extractBearerToken(req);
    if (bearerToken === null) throw new UnauthorizedError();

    const credentialCaller = await resolveRunCredentialCaller(pool, bearerToken, grantedCapabilities);
    if (credentialCaller) return credentialCaller;

    const identity = await authenticateRequest(pool, req);
    return {
      actor: { userId: identity.user.id, externalClient: true },
      capabilities: grantedCapabilities,
      tenantId: identity.tenantId,
    };
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" }, { Allow: "POST" });
      return;
    }

    let rpcId: unknown;
    try {
      const { actor, capabilities: effectiveCapabilities, tenantId } = await resolveActor(req);
      const serve = async (): Promise<void> => {
        let body: unknown;
        try {
          body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
        } catch (err) {
          if (err instanceof PayloadTooLargeError) {
            sendJson(res, 413, { error: err.message });
            return;
          }
          if (err instanceof ValidationError) {
            sendJson(res, 200, rpcError(null, -32700, "Parse error"));
            return;
          }
          throw err;
        }

        const rpc = body as JsonRpcRequestBody;
        rpcId = rpc.id ?? null;
        if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
          sendJson(res, 200, rpcError(rpcId, -32600, "Invalid Request"));
          return;
        }

        // A JSON-RPC notification (no `id`) is acknowledged with an empty 202, whatever its method.
        if (rpc.id === undefined) {
          res.writeHead(202, { "Cache-Control": "no-store" });
          res.end();
          return;
        }

        if (rpc.method === "initialize") {
          const params = rpc.params as { protocolVersion?: unknown; clientInfo?: unknown } | null | undefined;
          if (typeof params !== "object" || params === null || typeof params.protocolVersion !== "string") {
            sendJson(res, 200, rpcError(rpcId, -32602, "initialize requires params.protocolVersion"));
            return;
          }
          // A run credential's client names itself on its own run (issue #1788); a session names nothing.
          const runId = actor.runId;
          const clientName = readClientName(params.clientInfo);
          if (runId !== undefined && clientName !== null) {
            await withTransaction(pool, (client) => setAgentRunMcpClientName(client, runId, clientName));
          }
          const requested = params.protocolVersion;
          const protocolVersion =
            SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === requested) ?? SUPPORTED_PROTOCOL_VERSIONS[0];
          sendJson(
            res,
            200,
            rpcResult(rpcId, {
              protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "semprec", version: SERVER_VERSION },
            }),
          );
          return;
        }

        if (rpc.method === "tools/list") {
          const tools = gateway.listOperations(effectiveCapabilities).map((operation) => ({
            name: toMcpToolName(operation),
            inputSchema: operationInputJsonSchema(operation),
          }));
          if (actor.runId && actor.agentProjectItemId) {
            const modules = await resolveModuleAgentToolsForRun(
              pool,
              registry,
              actor.runId,
              actor.agentProjectItemId,
              effectiveCapabilities,
            );
            tools.push(
              ...modules.map((tool) => ({ name: `${MCP_TOOL_PREFIX}${tool.name}`, inputSchema: tool.argumentSchema })),
            );
          }
          sendJson(res, 200, rpcResult(rpcId, { tools }));
          return;
        }

        if (rpc.method === "tools/call") {
          const params = rpc.params as { name?: unknown; arguments?: unknown } | undefined;
          const toolName = typeof params?.name === "string" ? params.name : undefined;
          const operation = toolName !== undefined ? fromMcpToolName(toolName) : null;
          try {
            if (operation !== null) {
              const output = await gateway.invoke(operation, actor, effectiveCapabilities, params?.arguments ?? {});
              sendJson(res, 200, rpcResult(rpcId, { content: [{ type: "text", text: JSON.stringify(output) }] }));
            } else {
              const modules =
                actor.runId && actor.agentProjectItemId
                  ? await resolveModuleAgentToolsForRun(
                      pool,
                      registry,
                      actor.runId,
                      actor.agentProjectItemId,
                      effectiveCapabilities,
                    )
                  : [];
              const tool = modules.find((entry) => `${MCP_TOOL_PREFIX}${entry.name}` === toolName);
              if (!tool) {
                sendJson(res, 200, rpcError(rpcId, -32601, `Unknown tool '${toolName ?? ""}'`));
                return;
              }
              const output = await tool.invoke(params?.arguments ?? {});
              sendJson(
                res,
                200,
                rpcResult(rpcId, { content: [{ type: "text", text: output.result }], isError: output.error }),
              );
            }
          } catch (err) {
            if (err instanceof NotFoundError) {
              sendJson(res, 200, rpcError(rpcId, -32601, `Unknown tool '${toolName}'`));
              return;
            }
            if (err instanceof ApprovalRequiredError) {
              sendJson(res, 200, rpcError(rpcId, -32001, err.message, toPublicErrorBody(err).details));
              return;
            }
            if (err instanceof ValidationError) {
              sendJson(res, 200, rpcError(rpcId, -32602, err.message, toPublicErrorBody(err).details));
              return;
            }
            if (err instanceof ChokePointError) {
              sendJson(
                res,
                200,
                rpcError(rpcId, -32000, err.message, { code: err.code, details: toPublicErrorBody(err).details }),
              );
              return;
            }
            throw err;
          }
          return;
        }

        sendJson(res, 200, rpcError(rpcId, -32601, `Unknown method '${rpc.method}'`));
      };
      await runInTenant(tenantId, serve);
    } catch (err) {
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, toPublicErrorBody(err));
        return;
      }
      logger.error({ err }, "Unexpected error handling MCP request");
      sendJson(res, 500, { error: "Internal server error" });
    }
  }

  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the MCP request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
