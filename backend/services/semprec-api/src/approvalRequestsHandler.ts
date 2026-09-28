import type { IncomingMessage, ServerResponse } from "node:http";
import {
  withTransaction,
  ChokePointError,
  ValidationError,
  getApprovalRequest,
  decideAndEnqueueApprovalRequest,
  listApprovalRequestsQueue,
  toApprovalRequestDecisionView,
} from "@semprec/data";
import type { Pool } from "pg";
import { assertUuid } from "./adapter/requestValidation.js";
import { authenticateRequest } from "./authHandler.js";
import { logger } from "./logger.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

const MAX_BODY_BYTES = 1 * 1024 * 1024;

class PayloadTooLargeError extends Error {}

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
    throw new ValidationError("Request body is not valid JSON");
  }
}

const APPROVAL_REQUEST_PATH = /^\/api\/approval-requests\/([^/]+)$/;

/**
 * The authenticated-user approval surface: the global queue read (issue #132)
 * `GET /api/approval-requests` and the approve/reject write (issue #131)
 * `PATCH /api/approval-requests/:id`, body `{ decision: "approved" | "rejected" }`.
 *
 * The decider recorded in `approval_requests.decided_by` is the authenticated session's user
 * (`authenticateRequest`), never a client-supplied value. A `decidedByUserId` body field, which
 * the already-deployed web client still sends, is ignored rather than rejected — rejecting a field
 * a deployed client sends would break it (the additive-only REST contract ADR); the web client
 * stops sending it in a later batch.
 *
 * Delegates the actual state transition to `decideAndEnqueueApprovalRequest` — one atomic
 * `UPDATE ... WHERE status = 'pending'` plus, only on approval, enqueueing the reserved
 * `approvalExecute` job in the same transaction (see `approvalDecisionAction.ts`). A `null`
 * result there means the row was not `pending` (unknown id, or a repeat decision): this handler
 * treats that as a deterministic no-op, returning the request's current stored state with 200
 * rather than an error, and only 404s when the id doesn't exist at all — the client is expected
 * to render that returned state (possibly already decided by someone else) rather than treat the
 * no-op as a failure.
 *
 * Both 200 responses are `toApprovalRequestDecisionView`'s projection, not the stored row: the
 * payload is reduced to `safeSummary` (argument names, never values) exactly as on the queue read.
 */
export function createApprovalRequestsRequestListener(pool: Pool) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      const identity = await authenticateRequest(pool, req);

      if (req.method === "GET" && url.pathname === "/api/approval-requests") {
        const rows = await withTransaction(pool, (client) => listApprovalRequestsQueue(client));
        sendJson(res, 200, { rows });
        return;
      }

      const match = url.pathname.match(APPROVAL_REQUEST_PATH);
      if (!match || req.method !== "PATCH") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      // Group 1 of the route pattern above is not optional, so a successful match always
      // captured it; a runtime check here would be unreachable code.
      const approvalRequestId = assertUuid(match[1]!, "id");
      const body = (await readJsonBody(req)) as { decision?: unknown };
      if (body.decision !== "approved" && body.decision !== "rejected") {
        sendJson(res, 400, { error: "'decision' must be 'approved' or 'rejected'" });
        return;
      }
      const decision = body.decision;

      const decided = await withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId,
          decision,
          decidedByUserId: identity.user.id,
        }),
      );

      if (decided) {
        sendJson(res, 200, toApprovalRequestDecisionView(decided));
        return;
      }

      const existing = await withTransaction(pool, (client) => getApprovalRequest(client, approvalRequestId));
      if (!existing) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      sendJson(res, 200, toApprovalRequestDecisionView(existing));
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, { error: err.message, code: err.code, details: err.details });
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
