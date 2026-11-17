import type { IncomingMessage, ServerResponse } from "node:http";
import {
  APPROVAL_REQUEST_SOURCE_KINDS,
  withTransaction,
  ChokePointError,
  countPendingApprovalRequests,
  decideAndEnqueueApprovalRequest,
  getApprovalRequestForOwner,
  isMcpInvokeApprovalRequestPayload,
  listApprovalRequestsQueue,
  listApprovalRequestsQueuePage,
  parseApprovalRequestListCursor,
  toApprovalRequestArgumentValues,
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

/** Served before `APPROVAL_REQUEST_PATH` is tried, which would take `count` for an id. */
const APPROVAL_REQUEST_COUNT_PATH = "/api/approval-requests/count";

/** The presence of any one selects the paged answer. */
const LIST_PARAMETERS = ["status", "source", "q", "order", "cursor", "limit"] as const;
const LIST_STATUSES = ["pending", "decided"] as const;
const LIST_ORDERS = ["desc", "asc"] as const;

/** In Unicode code points. */
const MAX_SEARCH_CODE_POINTS = 100;

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
 * `null` when the request carries none of `LIST_PARAMETERS`. Defaults: `status` pending, `order`
 * desc, every `source`, `limit` 50. Another value, or a parameter given twice, is a
 * `ValidationError` naming it.
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
  // Trimmed first, so only searched text counts against the cap and a blank `q` is no filter.
  // Postgres refuses a NUL in a text value.
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
 * `status` accepts only `pending` (the default); `source` is an optional comma list of source
 * kinds. Other parameters are ignored, as on the list.
 */
function parseCountQuery(query: URLSearchParams) {
  const status = singleQueryValue(query, "status");
  if (status !== null && status !== "pending") {
    throw new ValidationError("'status' must be pending", { field: "status" });
  }
  const rawSource = singleQueryValue(query, "source");
  return { sourceKinds: rawSource === null ? null : parseSourceKinds(rawSource) };
}

/**
 * `GET /api/approval-requests` answers `{ rows }` (the caller's pending requests, oldest first)
 * without list parameters, and `{ rows, nextCursor }` with any of them. `/count` answers the number
 * the list returns for the same `status` and `source`. `GET /:id` answers one request in any
 * status; only an `mcpInvoke` request also carries `arguments`, redacted and bounded by
 * `toApprovalRequestArgumentValues`, and no other answer carries argument values
 * (docs/architecture/agents-approvals-and-ai.md#what-a-request-shows).
 *
 * `PATCH /:id` with `{ decision }` delegates to `decideAndEnqueueApprovalRequest`: one conditional
 * UPDATE on the caller being the run's actor plus, on approval, the `approvalExecute` job in the
 * same transaction. The decider is always the session user; a `decidedByUserId` body field is
 * ignored, not rejected, because deployed web clients still send it. A repeat decision answers 200
 * with the current state and `outcome: "unchanged"`.
 *
 * Another user's request, an unknown id and another tenant's id answer the same 404. Every 200 is
 * the `toApprovalRequestDecisionView` projection (argument names, never values) with `source` in
 * the session user's locale.
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

        if (url.pathname === APPROVAL_REQUEST_COUNT_PATH) {
          if (req.method !== "GET") {
            sendJson(res, 404, { error: "Not found" });
            return;
          }
          const { sourceKinds } = parseCountQuery(url.searchParams);
          const count = await withTransaction(pool, (client) =>
            countPendingApprovalRequests(client, { ownerUserId: identity.user.id, sourceKinds }),
          );
          sendJson(res, 200, { count });
          return;
        }

        const match = url.pathname.match(APPROVAL_REQUEST_PATH);
        if (!match || (req.method !== "PATCH" && req.method !== "GET")) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }

        // Group 1 of the route pattern is not optional.
        const approvalRequestId = assertUuid(match[1]!, "id");
        if (req.method === "GET") {
          const detail = await withTransaction(pool, async (client) => {
            const request = await getApprovalRequestForOwner(client, approvalRequestId, identity.user.id);
            if (!request) return null;
            const view = await toApprovalRequestDecisionView(client, request, identity.user.locale);
            // The one answer that carries argument values, and only for an `mcpInvoke` request.
            return isMcpInvokeApprovalRequestPayload(request.payload)
              ? { ...view, ...toApprovalRequestArgumentValues(request.payload.args) }
              : view;
          });
          if (!detail) {
            sendJson(res, 404, { error: "Not found" });
            return;
          }
          sendJson(res, 200, detail);
          return;
        }
        const body = (await readJsonBody(req, { maxBytes: MAX_BODY_BYTES })) as { decision?: unknown };
        if (body.decision !== "approved" && body.decision !== "rejected") {
          sendJson(res, 400, { error: "'decision' must be 'approved' or 'rejected'" });
          return;
        }
        const decision = body.decision;

        const answer = await withTransaction(pool, async (client) => {
          const decided = await decideAndEnqueueApprovalRequest(client, {
            approvalRequestId,
            decision,
            decidedByUserId: identity.user.id,
          });
          if (!decided) return null;
          const view = await toApprovalRequestDecisionView(client, decided.request, identity.user.locale);
          return { ...view, outcome: decided.outcome };
        });

        if (!answer) {
          sendJson(res, 404, { error: "Not found" });
          return;
        }
        sendJson(res, 200, answer);
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
   * `http.createServer` discards the listener's return value, so an async rejection would become an
   * unhandled rejection and exit the process. A synchronous boundary confines it to a 500 for the
   * one request.
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
