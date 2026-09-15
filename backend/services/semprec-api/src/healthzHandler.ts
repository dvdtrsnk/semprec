import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { isProcessHeartbeatFresh, withClient } from "@semprec/data";
import { logger } from "./logger.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

/**
 * Handles unauthenticated `GET /healthz` (issue #168). Responds 200 `{"status":"ok"}` only when
 * a plain `SELECT 1` and the `agents` process's heartbeat freshness both pass; any other outcome
 * — a DB error, a missing or stale `agents` row — is a 503 with the same minimal body. Neither
 * branch ever includes the underlying error or which specific check failed: a probe reachable
 * without a session must not become a way to learn why a deployment is unhealthy.
 */
export function createHealthzRequestListener(pool: Pool) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || url.pathname !== "/healthz") {
      sendJson(res, 404, { status: "error" });
      return;
    }

    try {
      const healthy = await withClient(pool, async (client) => {
        await client.query("SELECT 1");
        return isProcessHeartbeatFresh(client, "agents");
      });
      sendJson(res, healthy ? 200 : 503, { status: healthy ? "ok" : "error" });
    } catch (err) {
      logger.error({ err }, "GET /healthz check failed");
      sendJson(res, 503, { status: "error" });
    }
  }

  /** Same rationale as `setupHandler.ts`'s `handleRequestSafely`: confines an escaped rejection to this one request instead of an unhandled rejection that takes the whole process down. */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the healthz request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 503, { status: "error" });
    });
  };
}
