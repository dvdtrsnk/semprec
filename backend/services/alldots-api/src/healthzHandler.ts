import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { isProcessHeartbeatFresh, withClient } from "@alldots/data";
import { runAsSystem } from "@alldots/shared";
import { sendJson } from "./adapter/http.js";
import { logger } from "./logger.js";

/**
 * 200 `{"status":"ok"}` only when `SELECT 1` and this `api` process's own heartbeat freshness both
 * pass, otherwise 503 with the same minimal body. Gates on `api`, not on a process like `agents`
 * that may not be deployed alongside. No branch names the error or the failed check: an
 * unauthenticated probe must not reveal why a deployment is unhealthy.
 */
export function createHealthzRequestListener(pool: Pool) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || url.pathname !== "/healthz") {
      sendJson(res, 404, { status: "error" });
      return;
    }

    try {
      const healthy = await runAsSystem("healthz", () =>
        withClient(pool, async (client) => {
          await client.query("SELECT 1");
          return isProcessHeartbeatFresh(client, "api");
        }),
      );
      sendJson(res, healthy ? 200 : 503, { status: healthy ? "ok" : "error" });
    } catch (err) {
      logger.error({ err }, "GET /healthz check failed");
      sendJson(res, 503, { status: "error" });
    }
  }

  /**
   * Confines an escaped rejection to a 500 for this request instead of an unhandled rejection
   * ending the process.
   */
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
