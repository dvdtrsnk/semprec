import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { ApprovalRequiredError, ChokePointError, NotFoundError, ValidationError } from "@semprec/data";
import {
  GENERIC_OPERATION_NAMES,
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

/**
 * The authenticated MCP JSON-RPC endpoint (issue #220): `POST /mcp`, `tools/list` and
 * `tools/call` over the same 28-operation generic catalog REST (#219) and the AgentTool
 * composition root (`packages/agent-runtime/src/tools/generic`) dispatch through — MCP names are
 * the operation names prefixed `semprec.` (`fromMcpToolName`/`toMcpToolName`). The actor is
 * derived exclusively from `authenticateRequest`'s verified session/Bearer identity — never from
 * a JSON-RPC param — and carries no `runId`/`agentProjectItemId`, so `gateway.invoke`'s approval
 * gate is always a no-op for this transport (matching REST); an ungranted or unknown tool name
 * both resolve to the same JSON-RPC "method not found" rather than a distinguishable error, per
 * the issue's "never present-but-forbidden" requirement.
 *
 * `grantedCapabilities` is fixed per process (the schema core module's own registered
 * capabilities — see `schemaCoreModuleManifest.ts`), not derived per session: unlike an
 * AgentTool's per-project permission manifest, an authenticated MCP session has no project scope
 * to compute a manifest against.
 */
export function createMcpRequestListener(
  pool: Pool,
  gateway: GenericOperationGateway,
  grantedCapabilities: ReadonlySet<CapabilityId>,
) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    let rpcId: unknown;
    try {
      const identity = await authenticateRequest(pool, req);
      const actor: AuthenticatedActor = { userId: identity.user.id };

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
        const tools = gateway.listOperations(grantedCapabilities).map((operation) => ({
          name: toMcpToolName(operation),
          inputSchema: { type: "object" },
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
          const output = await gateway.invoke(operation, actor, grantedCapabilities, params?.arguments ?? {});
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
