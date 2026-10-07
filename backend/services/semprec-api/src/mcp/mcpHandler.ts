import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  ApprovalRequiredError,
  ChokePointError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  resolveMcpRunCredential,
} from "@semprec/data";
import {
  CAPABILITY_IDS,
  GENERIC_OPERATION_NAMES,
  operationInputJsonSchema,
  runAsSystem,
  runInTenant,
  type AuthenticatedActor,
  type CapabilityId,
  type GenericOperationName,
} from "@semprec/shared";
import type { GenericOperationGateway } from "@semprec/application";
import { toPublicErrorBody } from "../adapter/errorContract.js";
import { extractBearerToken, PayloadTooLargeError, readJsonBody, sendJson } from "../adapter/http.js";
import { authenticateRequest } from "../authHandler.js";
import { logger } from "../logger.js";

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

/**
 * The authenticated MCP JSON-RPC endpoint (issue #220): `POST /mcp`, `tools/list` and
 * `tools/call` over the same 29-operation generic catalog REST (#219) and the AgentTool
 * composition root (`packages/agent-runtime/src/tools/generic`) dispatch through — MCP names are
 * the operation names prefixed `semprec.` (`fromMcpToolName`/`toMcpToolName`).
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
 *  2. `authenticateRequest`'s verified human session/Bearer identity (unmodified) — the original,
 *     unrestricted path: `{ userId }` alone, no `runId`, so the approval gate stays a no-op for it,
 *     same as REST.
 * Either way, an ungranted or unknown tool name resolve to the same JSON-RPC "method not found"
 * rather than a distinguishable error, per the issue's "never present-but-forbidden" requirement.
 *
 * `grantedCapabilities` is fixed per process (the schema core module's own registered
 * capabilities — see `schemaCoreModuleManifest.ts`); a restricted credential's own capability list
 * is intersected against it, so a credential can only ever narrow what a process already grants,
 * never widen it.
 */
export function createMcpRequestListener(
  pool: Pool,
  gateway: GenericOperationGateway,
  grantedCapabilities: ReadonlySet<CapabilityId>,
) {
  async function resolveActor(
    req: IncomingMessage,
  ): Promise<{ actor: AuthenticatedActor; capabilities: ReadonlySet<CapabilityId>; tenantId: string }> {
    const bearerToken = extractBearerToken(req);
    if (bearerToken === null) throw new UnauthorizedError();

    // The token is resolved to its tenant in the global plane before any tenant is known; the
    // credential itself is then read under RLS inside that tenant (`resolveMcpRunCredential`).
    const credential = await runAsSystem("mcp-run-credential-lookup", () => resolveMcpRunCredential(pool, bearerToken));
    if (credential) {
      const capabilities = new Set(
        (CAPABILITY_IDS as readonly CapabilityId[]).filter(
          (id) => credential.capabilities.includes(id) && grantedCapabilities.has(id),
        ),
      );
      return {
        actor: {
          userId: credential.actorUserId,
          runId: credential.runId,
          agentProjectItemId: credential.agentProjectItemId,
        },
        capabilities,
        tenantId: credential.tenantId,
      };
    }

    const identity = await authenticateRequest(pool, req);
    return { actor: { userId: identity.user.id }, capabilities: grantedCapabilities, tenantId: identity.tenantId };
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      sendJson(res, 404, { error: "Not found" });
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

        if (rpc.method === "tools/list") {
          const tools = gateway.listOperations(effectiveCapabilities).map((operation) => ({
            name: toMcpToolName(operation),
            inputSchema: operationInputJsonSchema(operation),
          }));
          sendJson(res, 200, rpcResult(rpcId, { tools }));
          return;
        }

        if (rpc.method === "tools/call") {
          const params = rpc.params as { name?: unknown; arguments?: unknown } | undefined;
          const toolName = typeof params?.name === "string" ? params.name : undefined;
          const operation = toolName !== undefined ? fromMcpToolName(toolName) : null;
          if (operation === null) {
            sendJson(res, 200, rpcError(rpcId, -32601, `Unknown tool '${toolName ?? ""}'`));
            return;
          }
          try {
            const output = await gateway.invoke(operation, actor, effectiveCapabilities, params?.arguments ?? {});
            sendJson(res, 200, rpcResult(rpcId, { content: [{ type: "text", text: JSON.stringify(output) }] }));
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
