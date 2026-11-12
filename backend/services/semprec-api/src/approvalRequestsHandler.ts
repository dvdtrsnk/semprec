import type { IncomingMessage, ServerResponse } from "node:http";
import {
  APPROVAL_REQUEST_SOURCE_KINDS,
  withTransaction,
  ChokePointError,
  decideAndEnqueueApprovalRequest,
  listApprovalRequestsQueue,
  listApprovalRequestsQueuePage,
  parseApprovalRequestListCursor,
  toApprovalRequestDecisionView,
  ValidationError,
  type ApprovalRequestSourceKind,
} from "@semprec/data";
import type { Pool } from "pg";
import { toPublicErrorBody } from "./adapter/errorContract.js";
import { assertUuid } from "./adapter/requestValidation.js";
import { PayloadTooLargeError, readJsonBody, sendJson } from "./adapter/http.js";
import { runInTenant } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { logger } from "./logger.js";

const MAX_BODY_BYTES = 1 * 1024 * 1024;

const APPROVAL_REQUEST_PATH = /^\/api\/approval-requests\/([^/]+)$/;

/** The query parameters of `GET /api/approval-requests`; the presence of any one selects the paged answer. */
const LIST_PARAMETERS = ["status", "source", "q", "order", "cursor", "limit"] as const;
const LIST_STATUSES = ["pending", "decided"] as const;
const LIST_ORDERS = ["desc", "asc"] as const;

/** Longest search text `GET /api/approval-requests` takes in `q`, in Unicode code points. */
const MAX_SEARCH_CODE_POINTS = 100;

/** The value of a query parameter that may be given at most once; null when it is absent. */
function singleQueryValue(query: URLSearchParams, name: string): string | null {
  const values = query.getAll(name);
  if (values.length > 1) throw new ValidationError(`'${name}' must be given at most once`, { field: name });
  return values[0] ?? null;
}

function parseSourceKinds(value: string): ApprovalRequestSourceKind[] {
  const kinds = new Set<ApprovalRequestSourceKind>();
  for (const entry of value.split(",")) {
    const kind = APPROVAL_REQUEST_SOURCE_KINDS.find((known) => known === entry);
    if (kind === undefined) {
      throw new ValidationError("'source' must be a comma-separated list of chat, tick and mcp", { field: "source" });
    }
    kinds.add(kind);
  }
  return [...kinds];
}

/**
 * The validated query of the paged `GET /api/approval-requests` (issue #1785), or null when the
 * request carries none of `LIST_PARAMETERS` and gets the answer the route gave before them. An
 * absent `status` is `pending`, an absent `order` is `desc` (newest first), an absent `source` is
 * every source and an absent `limit` is 50. A parameter of another value, or given twice, is a
 * `ValidationError` that names it.
 */
function parseListQuery(query: URLSearchParams) {
  if (!LIST_PARAMETERS.some((name) => query.has(name))) return null;
  const rawStatus = singleQueryValue(query, "status");
  const status = rawStatus === null ? "pending" : LIST_STATUSES.find((known) => known === rawStatus);
  if (status === undefined) throw new ValidationError("'status' must be pending or decided", { field: "status" });
  const rawOrder = singleQueryValue(query, "order");
  const order = rawOrder === null ? "desc" : LIST_ORDERS.find((known) => known === rawOrder);
  if (order === undefined) throw new ValidationError("'order' must be desc or asc", { field: "order" });
  const rawSource = singleQueryValue(query, "source");
  const rawLimit = singleQueryValue(query, "limit");
  if (rawLimit !== null && (!/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 100))
    throw new ValidationError("'limit' must be an integer between 1 and 100", { field: "limit" });
  const rawCursor = singleQueryValue(query, "cursor");
  // Trimmed first: only the text that is searched counts against the cap, and a blank `q` is no filter.
  // Postgres refuses a NUL character in a text value, so one is refused here.
  const search = singleQueryValue(query, "q")?.trim() ?? "";
  if (search.includes("\u0000") || Array.from(search).length > MAX_SEARCH_CODE_POINTS)
    throw new ValidationError(`'q' must be at most ${MAX_SEARCH_CODE_POINTS} characters without a NUL character`, {
      field: "q",
    });
  return {
    status,
    order,
    sourceKinds: rawSource === null ? null : parseSourceKinds(rawSource),
    search: search === "" ? null : search,
    limit: rawLimit === null ? 50 : Number(rawLimit),
    cursor: rawCursor === null ? null : parseApprovalRequestListCursor(rawCursor),
  };
}

/**
 * The authenticated-user approval surface: the global queue read (issue #132)
 * `GET /api/approval-requests` and the approve/reject write (issue #131)
 * `PATCH /api/approval-requests/:id`, body `{ decision: "approved" | "rejected" }`.
 *
 * Without any of the query parameters `status`, `source`, `q`, `order`, `cursor` and `limit` the
 * read answers `{ rows }` with the caller's pending requests, oldest first. With any of them it
 * answers `{ rows, nextCursor }` with one page of the list `parseListQuery` describes (issue
 * #1785); an invalid value of one of them is a 400 `validation_failed`.
 *
 * The decider recorded in `approval_requests.decided_by` is the authenticated session's user
 * (`authenticateRequest`), never a client-supplied value. A `decidedByUserId` body field, which
 * the already-deployed web client still sends, is ignored rather than rejected — rejecting a field
 * a deployed client sends would break it (the additive-only REST contract ADR); the web client
 * stops sending it in a later batch.
 *
 * Delegates the actual state transition to `decideAndEnqueueApprovalRequest` — one atomic
 * `UPDATE ... WHERE status = 'pending'` conditioned on the caller being the run's actor, plus,
 * only on approval, enqueueing the reserved `approvalExecute` job in the same transaction (see
 * `approvalDecisionAction.ts`). A repeat decision by the owner answers 200 with the current state.
 * An unknown, foreign or other-tenant id answers the same 404 body, so the response never reveals
 * whether a request exists for someone else (issue #1028).
 *
 * Both 200 responses are `toApprovalRequestDecisionView`'s projection, not the stored row: the
 * payload is reduced to `safeSummary` (argument names, never values) exactly as on the queue read.
 *
 * Every row of the queue read and both 200 responses of the write carry `source` (issue #1766),
 * derived in the session user's `users.locale`.
 */
export function createApprovalRequestsRequestListener(pool: Pool) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      const identity = await authenticateRequest(pool, req);

      await runInTenant(identity.tenantId, async () => {
        if (req.method === "GET" && url.pathname === "/api/approval-requests") {
          const pageQuery = parseListQuery(url.searchParams);
          if (pageQuery === null) {
            const rows = await withTransaction(pool, (client) =>
              listApprovalRequestsQueue(client, identity.user.id, identity.user.locale),
            );
            sendJson(res, 200, { rows });
            return;
          }
          const page = await withTransaction(pool, (client) =>
            listApprovalRequestsQueuePage(client, {
              ...pageQuery,
              ownerUserId: identity.user.id,
              locale: identity.user.locale,
            }),
          );
          sendJson(res, 200, page);
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
        const body = (await readJsonBody(req, { maxBytes: MAX_BODY_BYTES })) as { decision?: unknown };
        if (body.decision !== "approved" && body.decision !== "rejected") {
          sendJson(res, 400, { error: "'decision' must be 'approved' or 'rejected'" });
          return;
        }
        const decision = body.decision;

        const view = await withTransaction(pool, async (client) => {
          const decided = await decideAndEnqueueApprovalRequest(client, {
            approvalRequestId,
            decision,
            decidedByUserId: identity.user.id,
          });
          return decided ? await toApprovalRequestDecisionView(client, decided.request, identity.user.locale) : null;
        });

        if (!view) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }
        sendJson(res, 200, view);
      });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: err.message });
        return;
      }
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
