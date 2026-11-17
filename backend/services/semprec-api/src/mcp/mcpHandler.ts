import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  ApprovalRequiredError,
  ChokePointError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  createModuleToolApprovalRequest,
  resolveModuleAgentToolsForRun,
  resolveModuleAgentToolsForUser,
  setAgentRunMcpClientName,
  type ResolvedHumanModuleAgentTool,
  type ResolvedModuleAgentTool,
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
import type { CustomRouteDependencies } from "../adapter/customRouteMount.js";
import { authenticateRequest } from "../authHandler.js";
import { resolveRunCredentialCaller } from "./callerActor.js";
import { logger } from "../logger.js";

/** Newest first; the first is the fallback. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

const SERVER_VERSION = (() => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string") throw new Error("semprec-api package.json has no version string");
  return manifest.version;
})();

const MCP_TOOL_PREFIX = "semprec.";

function isArgumentsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A run credential's tools can be approval-gated and are bound to the run; a human session's run as
 * its user.
 */
type CallerModuleTools =
  | { kind: "run"; runId: string; tools: ResolvedModuleAgentTool[] }
  | { kind: "user"; tools: ResolvedHumanModuleAgentTool[] };

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

function readClientName(clientInfo: unknown): string | null {
  if (typeof clientInfo !== "object" || clientInfo === null) return null;
  const name: unknown = "name" in clientInfo ? clientInfo.name : undefined;
  return typeof name === "string" ? name : null;
}

/**
 * `initialize`, `tools/list` and `tools/call` over the generic catalog shared with REST and
 * AgentTool; MCP names are operation names prefixed `semprec.`. REST-only operations
 * (`REST_ONLY_OPERATION_NAMES`) are neither listed nor callable here.
 *
 * A request without a bearer token is rejected before any session lookup; the web session cookie is
 * never consulted.
 *
 * The actor is derived, in order, from:
 * 1. A restricted run credential (minted via `POST /api/agent-runs/mcp-credentials`): `{ userId,
 * runId, agentProjectItemId }`, so the approval gate applies and operations are restricted to its
 * capability subset.
 * 2. A human session: `{ userId, externalClient: true }` with no `runId`, so the approval gate is a
 * no-op as on REST. `externalClient` makes the data layer refuse every sensitive database, which a
 * REST call of the same user still reads.
 * Module tools follow the same split: a run credential sees `mcp`-declared tools of modules its
 * project holds grants for and its list names; a human session sees the `mcp`-declared tools of the
 * active modules, each running as its user without approval. An ungranted and an unknown tool name
 * get the same "method not found", never a distinguishable error.
 *
 * A run credential's call of a `requiresApproval` tool files a `moduleTool` approval request and
 * answers -32001; the handler runs once the owner approves. A session's call runs as the user.
 *
 * `grantedCapabilities` is fixed per process; a credential's list is intersected with it, so it can
 * only narrow, never widen.
 */
export async function createMcpRequestListener(
  pool: Pool,
  gateway: GenericOperationGateway,
  grantedCapabilities: ReadonlySet<CapabilityId>,
  registry: ModuleRegistry,
  moduleToolDependencies: CustomRouteDependencies = {},
) {
  const activeNames = await registry.getActiveAgentToolNames();
  const collision = activeNames.find((name) => (GENERIC_OPERATION_NAMES as readonly string[]).includes(name));
  if (collision) throw new Error(`Module tool collides with generic operation: ${collision}`);
  async function resolveActor(req: IncomingMessage): Promise<{
    actor: AuthenticatedActor;
    capabilities: ReadonlySet<CapabilityId>;
    moduleCapabilities: ReadonlySet<string>;
    tenantId: string;
  }> {
    const bearerToken = extractBearerToken(req);
    if (bearerToken === null) throw new UnauthorizedError();

    const credentialCaller = await resolveRunCredentialCaller(pool, bearerToken, grantedCapabilities);
    if (credentialCaller) return credentialCaller;

    const identity = await authenticateRequest(pool, req);
    return {
      actor: { userId: identity.user.id, externalClient: true },
      capabilities: grantedCapabilities,
      moduleCapabilities: new Set(),
      tenantId: identity.tenantId,
    };
  }

  /** Approval-gated ones included (a call files their request). */
  async function resolveModuleTools(
    actor: AuthenticatedActor,
    capabilities: ReadonlySet<CapabilityId>,
    moduleCapabilities: ReadonlySet<string>,
  ): Promise<CallerModuleTools> {
    if (actor.runId && actor.agentProjectItemId) {
      return {
        kind: "run",
        runId: actor.runId,
        tools: await resolveModuleAgentToolsForRun(
          pool,
          registry,
          actor.runId,
          actor.agentProjectItemId,
          new Set<string>([...capabilities, ...moduleCapabilities]),
          { mcpExposure: true, includeApprovalGated: true },
        ),
      };
    }
    if (actor.externalClient === true) {
      return {
        kind: "user",
        tools: await resolveModuleAgentToolsForUser(pool, registry, actor.userId, moduleToolDependencies),
      };
    }
    return { kind: "user", tools: [] };
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" }, { Allow: "POST" });
      return;
    }

    let rpcId: unknown;
    try {
      const { actor, capabilities: effectiveCapabilities, moduleCapabilities, tenantId } = await resolveActor(req);
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
          // A run credential's client names itself on its own run; a session names nothing.
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
          const modules = await resolveModuleTools(actor, effectiveCapabilities, moduleCapabilities);
          tools.push(
            ...modules.tools.map((tool) => ({
              name: `${MCP_TOOL_PREFIX}${tool.name}`,
              inputSchema: tool.argumentSchema,
            })),
          );
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
              const modules = await resolveModuleTools(actor, effectiveCapabilities, moduleCapabilities);
              const tool = modules.tools.find((entry) => `${MCP_TOOL_PREFIX}${entry.name}` === toolName);
              if (!tool) {
                sendJson(res, 200, rpcError(rpcId, -32601, `Unknown tool '${toolName ?? ""}'`));
                return;
              }
              const args = params?.arguments ?? {};
              // Only a run's tool can be gated: a session has no run to file the request for.
              const gated = modules.kind === "run" ? modules.tools.find((entry) => entry === tool) : undefined;
              if (modules.kind === "run" && gated?.requiresApproval) {
                // The handler runs only after the owner approved the request, as in an agent
                // session.
                if (!gated.acceptsArguments(args) || !isArgumentsObject(args)) {
                  throw new ValidationError("Invalid tool arguments.");
                }
                const request = await createModuleToolApprovalRequest(pool, {
                  agentRunId: modules.runId,
                  toolName: gated.name,
                  riskClass: gated.riskClass,
                  args,
                  snapshotSha256: await gated.snapshotOf(args),
                  toolCallId: null,
                });
                throw new ApprovalRequiredError(`Tool '${gated.name}' requires human approval before it can run.`, {
                  approvalRequestId: request.id,
                  link: `?page=approvals&id=${request.id}`,
                });
              }
              const output = await tool.invoke(args);
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
