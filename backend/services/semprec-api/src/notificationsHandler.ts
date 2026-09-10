import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  withTransaction,
  ChokePointError,
  NotFoundError,
  listUnreadNotificationsForUser,
  visitNotification,
  markAllNotificationsRead,
} from "@semprec/data";
import { authenticateRequest } from "./authHandler.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

const VISIT_NOTIFICATION_PATH = /^\/api\/notifications\/([^/]+)\/visit$/;

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
        const notificationId = visitMatch[1]!;
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
    } catch (err) {
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, { error: err.message, code: err.code, details: err.details });
        return;
      }
      console.error(`Unexpected error in ${req.method} ${url.pathname}:`, err);
      sendJson(res, 500, { error: "Internal server error" });
    }
  }

  /**
   * `http.createServer` discards its listener's return value, so an `async` listener turns any
   * rejection escaping the try/catch above into an unhandled rejection — which Node answers by
   * exiting the process. Keeping the boundary synchronous confines it to a 500 for the one
   * request. Same shape as `aiUsageHandler.ts`.
   */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      console.error("Unhandled error in the request listener:", err);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
