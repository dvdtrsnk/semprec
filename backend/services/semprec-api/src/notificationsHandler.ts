import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  withTransaction,
  ChokePointError,
  NotFoundError,
  ValidationError,
  listResolvedNotificationIds,
  listUnreadNotificationsForUser,
  visitNotification,
  markAllNotificationsRead,
} from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import { authenticateRequest } from "./authHandler.js";
import { toPublicErrorBody } from "./adapter/errorContract.js";
import { sendJson } from "./adapter/http.js";
import { assertUuid } from "./adapter/requestValidation.js";
import { logger } from "./logger.js";

const VISIT_NOTIFICATION_PATH = /^\/api\/notifications\/([^/]+)\/visit$/;

function requireResolvedSince(value: string | null): string {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/);
  if (!value || value.length > 32 || !match) throw new ValidationError("Invalid since timestamp", { field: "since" });
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = match[7]!;
  const zoneHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const zoneMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (days[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    zoneHour > 15 ||
    zoneMinute > 59
  )
    throw new ValidationError("Invalid since timestamp", { field: "since" });
  return value;
}

/**
 * Issue #152's authenticated notification surface: `GET /api/notifications/unread` (a
 * reconnecting client's recovery path — every unread row for the caller, ordered deterministically
 * so live frames it already applied can be told apart from ones it missed), `POST
 * /api/notifications/:id/visit` (idempotent visit-and-read, returning the row so the client can
 * navigate to its `linkHref`), and `POST /api/notifications/mark-all-read` (the optional
 * convenience the issue's Task allows).
 *
 * All three are scoped to `identity.user.id` from `authenticateRequest` (issue #143) — a
 * notification id belonging to another user is indistinguishable from an unknown one, see
 * `visitNotification`'s doc comment.
 */
export function createNotificationsRequestListener(pool: Pool) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      const identity = await authenticateRequest(pool, req);

      await runInTenant(identity.tenantId, async () => {
        if (req.method === "GET" && url.pathname === "/api/notifications/resolved") {
          const since = requireResolvedSince(url.searchParams.get("since"));
          const rawAfterId = url.searchParams.get("afterId");
          const afterId = rawAfterId === null ? undefined : assertUuid(rawAfterId, "afterId");
          const resolved = await withTransaction(pool, (client) =>
            listResolvedNotificationIds(client, identity.user.id, since, 500, afterId),
          );
          const last = resolved.at(-1);
          sendJson(res, 200, { resolved, nextCursor: last ? { since: last.resolvedAt, afterId: last.id } : null });
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/notifications/unread") {
          const notifications = await withTransaction(pool, (client) =>
            listUnreadNotificationsForUser(client, identity.user.id),
          );
          sendJson(res, 200, { notifications });
          return;
        }

        if (req.method === "POST" && url.pathname === "/api/notifications/mark-all-read") {
          const notifications = await withTransaction(pool, (client) =>
            markAllNotificationsRead(client, identity.user.id),
          );
          sendJson(res, 200, { notifications });
          return;
        }

        const visitMatch = url.pathname.match(VISIT_NOTIFICATION_PATH);
        if (req.method === "POST" && visitMatch) {
          // Group 1 of VISIT_NOTIFICATION_PATH is not optional, so a successful match always
          // captured it; a runtime check here would be unreachable code.
          const notificationId = assertUuid(visitMatch[1]!, "id");
          const notification = await withTransaction(pool, (client) =>
            visitNotification(client, identity.user.id, notificationId),
          );
          if (!notification) {
            throw new NotFoundError("Not found");
          }
          sendJson(res, 200, { notification });
          return;
        }

        sendJson(res, 404, { error: "Not found" });
      });
    } catch (err) {
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
