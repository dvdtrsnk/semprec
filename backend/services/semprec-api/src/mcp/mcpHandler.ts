import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  ApprovalRequiredError,
  ChokePointError,
  NotFoundError,
  ValidationError,
  withTransaction,
  resolveMcpRunCredential,
} from "@semprec/data";
import {
  CAPABILITY_IDS,
  GENERIC_OPERATION_NAMES,
  operationInputJsonSchema,
  type AuthenticatedActor,
  type CapabilityId,
  type GenericOperationName,
} from "@semprec/shared";
import type { GenericOperationGateway } from "@semprec/application";
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } };
}

const MAX_BODY_BYTES = 1 * 1024 * 1024;

class PayloadTooLargeError extends Error {}
class JsonParseError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError("Request body exceeds the maximum allowed size");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new JsonParseError("Request body is not valid JSON");
  }
}

interface JsonRpcRequestBody {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

/** Reads the raw bearer token only — this endpoint never accepts a cookie, unlike `authHandler.ts`'s `extractToken`. */
function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/**
 * The authenticated MCP JSON-RPC endpoint (issue #220): `POST /mcp`, `tools/list` and
 * `tools/call` over the same 28-operation generic catalog REST (#219) and the AgentTool
 * composition root (`packages/agent-runtime/src/tools/generic`) dispatch through — MCP names are
 * the operation names prefixed `semprec.` (`fromMcpToolName`/`toMcpToolName`).
 *
 * The actor is derived one of two ways, tried in this order (AC34/44/47):
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
  ): Promise<{ actor: AuthenticatedActor; capabilities: ReadonlySet<CapabilityId> }> {
    const bearerToken = extractBearerToken(req);
    const credential = bearerToken
      ? await withTransaction(pool, (client) => resolveMcpRunCredential(client, bearerToken))
      : null;
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
      };
    }

    const identity = await authenticateRequest(pool, req);
    return { actor: { userId: identity.user.id }, capabilities: grantedCapabilities };
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    let rpcId: unknown;
    try {
      const { actor, capabilities: effectiveCapabilities } = await resolveActor(req);

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          sendJson(res, 413, { error: err.message });
          return;
        }
        if (err instanceof JsonParseError) {
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
            sendJson(res, 200, rpcError(rpcId, -32001, err.message, err.details));
            return;
          }
          if (err instanceof ValidationError) {
            sendJson(res, 200, rpcError(rpcId, -32602, err.message, err.details));
            return;
          }
          if (err instanceof ChokePointError) {
            sendJson(res, 200, rpcError(rpcId, -32000, err.message, { code: err.code, details: err.details }));
            return;
          }
          throw err;
        }
        return;
      }

      sendJson(res, 200, rpcError(rpcId, -32601, `Unknown method '${rpc.method}'`));
    } catch (err) {
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, { error: err.message, code: err.code, details: err.details });
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
