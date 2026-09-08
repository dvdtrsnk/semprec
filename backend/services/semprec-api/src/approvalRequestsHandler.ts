import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  withTransaction,
  ChokePointError,
  ValidationError,
  getApprovalRequest,
  decideAndEnqueueApprovalRequest,
  listApprovalRequestsQueue,
} from "@semprec/data";
import type { Pool } from "pg";

export interface ApprovalRequestsHandlerOptions {
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

const FOREIGN_KEY_VIOLATION_ERRCODE = "23503";

function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === FOREIGN_KEY_VIOLATION_ERRCODE;
}

/**
 * The authenticated-user approval surface: the global queue read (issue #132)
 * `GET /api/approval-requests` and the approve/reject write (issue #131)
 * `PATCH /api/approval-requests/:id`, body `{ decision: "approved" | "rejected",
 * decidedByUserId: string }`.
 *
 * `decidedByUserId` is a stopgap request-body field, not a real session's user id — same
 * "documented stopgap, trivial to swap once auth-v1 (#138-143) lands" convention as this
 * package's other handlers' `authToken` (see `aiUsageHandler.ts`'s comment).
 *
 * Delegates the actual state transition to `decideAndEnqueueApprovalRequest` — one atomic
 * `UPDATE ... WHERE status = 'pending'` plus, only on approval, enqueueing the reserved
 * `approvalExecute` job in the same transaction (see `approvalDecisionAction.ts`). A `null`
 * result there means the row was not `pending` (unknown id, or a repeat decision): this handler
 * treats that as a deterministic no-op, returning the request's current stored state with 200
 * rather than an error, and only 404s when the id doesn't exist at all — the client is expected
 * to render that returned state (possibly already decided by someone else) rather than treat the
 * no-op as a failure.
 */
export function createApprovalRequestsRequestListener(pool: Pool, options: ApprovalRequestsHandlerOptions) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAuthorized(req, options.authToken)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    try {
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

      const [, approvalRequestId] = match;
      const body = (await readJsonBody(req)) as { decision?: unknown; decidedByUserId?: unknown };
      if (body.decision !== "approved" && body.decision !== "rejected") {
        sendJson(res, 400, { error: "'decision' must be 'approved' or 'rejected'" });
        return;
      }
      if (typeof body.decidedByUserId !== "string" || body.decidedByUserId.length === 0) {
        sendJson(res, 400, { error: "'decidedByUserId' must be a non-empty string" });
        return;
      }

      let decided;
      try {
        decided = await withTransaction(pool, (client) =>
          decideAndEnqueueApprovalRequest(client, {
            approvalRequestId,
            decision: body.decision as "approved" | "rejected",
            decidedByUserId: body.decidedByUserId as string,
          }),
        );
      } catch (err) {
        if (isForeignKeyViolation(err)) {
          sendJson(res, 400, { error: `No user with id '${body.decidedByUserId}'` });
          return;
        }
        throw err;
      }

      if (decided) {
        sendJson(res, 200, decided);
        return;
      }

      const existing = await withTransaction(pool, (client) => getApprovalRequest(client, approvalRequestId));
      if (!existing) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      sendJson(res, 200, existing);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, { error: err.message, code: err.code, details: err.details });
        return;
      }
      console.error(`Unexpected error in ${req.method} ${url.pathname}:`, err);
      sendJson(res, 500, { error: "Internal server error" });
    }
  };
}
