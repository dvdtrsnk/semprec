import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { handleGraphChangeNotification } from "@semprec/data";
import { runAsSystem } from "@semprec/shared";
import { NO_STORE, PayloadTooLargeError, readRawBody, sendJson } from "./adapter/http.js";
import { logger } from "./logger.js";

/**
 * Generous for a real Graph delivery (Graph caps a batch around 20 notifications), but bounds a
 * malicious POST.
 */
const MAX_BODY_BYTES = 256 * 1024;

interface RawNotification {
  subscriptionId: string;
  clientState?: string;
}

/** A Graph notification carries other fields this receiver does not act on. */
function parseNotification(value: unknown): RawNotification | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.subscriptionId !== "string" || !record.subscriptionId) return undefined;
  return {
    subscriptionId: record.subscriptionId,
    clientState: typeof record.clientState === "string" ? record.clientState : undefined,
  };
}

/**
 * Unauthenticated by design: Graph is the only caller, and each notification's `clientState`
 * (checked in constant time by `handleGraphChangeNotification`) is the safeguard. Listed among the
 * public exceptions in `routeMatrix.ts`.
 *
 * The validation handshake (`?validationToken=`, body not a notification batch) is handled first
 * and unconditionally, answering the literal token as `text/plain`, which Graph matches
 * byte-for-byte.
 */
export function createGraphWebhookRequestListener(pool: Pool) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method !== "POST") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const validationToken = url.searchParams.get("validationToken");
    if (validationToken !== null) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": NO_STORE });
      res.end(validationToken);
      return;
    }

    try {
      const raw = await readRawBody(req, { maxBytes: MAX_BODY_BYTES });
      let parsed: unknown;
      try {
        parsed = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {};
      } catch {
        sendJson(res, 400, { error: "Request body is not valid JSON" });
        return;
      }
      if (typeof parsed !== "object" || parsed === null) {
        sendJson(res, 400, { error: "Request body must be a JSON object" });
        return;
      }

      const rawValue = (parsed as Record<string, unknown>).value;
      const notifications = Array.isArray(rawValue)
        ? rawValue.map(parseNotification).filter((n): n is RawNotification => n !== undefined)
        : [];

      await runAsSystem("graph-webhook", async () => {
        for (const notification of notifications) {
          const outcome = await handleGraphChangeNotification(pool, notification);
          if (outcome !== "accepted") {
            logger.warn(
              { subscriptionId: notification.subscriptionId, outcome },
              "Graph webhook notification rejected",
            );
          }
        }
      });

      // 202 regardless of individual outcomes: Graph disables a subscription whose endpoint does
      // not answer promptly with a 2xx, so a rejected notification is logged and dropped rather
      // than redelivered.
      res.writeHead(202, { "Cache-Control": NO_STORE });
      res.end();
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      logger.error({ err }, "Unexpected error handling Graph webhook request");
      sendJson(res, 500, { error: "Internal server error" });
    }
  }

  /**
   * Confines an escaped rejection to a 500 for this request instead of an unhandled rejection
   * ending the process.
   */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the Graph webhook request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
