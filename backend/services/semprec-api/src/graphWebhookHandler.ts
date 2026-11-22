import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { handleGraphChangeNotification } from "@semprec/data";
import { runAsSystem } from "@semprec/shared";
import { NO_STORE, PayloadTooLargeError, readRawBody, sendJson } from "./adapter/http.js";
import { clientIpFromRequest } from "./clientIp.js";
import { createClientIpThrottle, type ClientIpThrottle } from "./clientIpThrottle.js";
import { distinctGraphNotifications } from "./graphNotificationBatch.js";
import { logger } from "./logger.js";

export interface GraphWebhookRequestListenerOptions {
  /** Read the throttle key from the last `X-Forwarded-For` hop. */
  trustProxy: boolean;
  /** Defaults to one fresh limiter per listener. */
  clientIpThrottle?: ClientIpThrottle;
}

/**
 * Generous for a real Graph delivery (Graph caps a batch around 20 notifications), but bounds a
 * malicious POST.
 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Unauthenticated by design: Graph is the only caller, and each notification's `clientState`
 * (checked in constant time by `handleGraphChangeNotification`) is the safeguard. Listed among the
 * public exceptions in `routeMatrix.ts`.
 *
 * Every POST, the handshake included, counts under `mailWebhook` per client address first, before
 * the body is read or the database is; over the limit it answers an empty 429 with `Retry-After`.
 *
 * The validation handshake (`?validationToken=`, body not a notification batch) is handled next,
 * answering the literal token as `text/plain`, which Graph matches byte-for-byte.
 *
 * A repeated `(subscriptionId, clientState)` pair is looked up once, and at most
 * `MAX_GRAPH_NOTIFICATIONS` distinct pairs per batch (`distinctGraphNotifications`).
 */
export function createGraphWebhookRequestListener(pool: Pool, options: GraphWebhookRequestListenerOptions) {
  const throttle = options.clientIpThrottle ?? createClientIpThrottle();

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method !== "POST") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const acquisition = throttle.tryAcquire(
      "mailWebhook",
      clientIpFromRequest(req, { trustProxy: options.trustProxy }),
    );
    if (!acquisition.granted) {
      res.writeHead(429, { "Retry-After": String(acquisition.retryAfterSeconds), "Cache-Control": NO_STORE });
      res.end();
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
      const notifications = Array.isArray(rawValue) ? distinctGraphNotifications(rawValue) : [];

      await runAsSystem("graph-webhook", async () => {
        for (const { subscriptionId, clientState } of notifications) {
          const outcome = await handleGraphChangeNotification(pool, {
            subscriptionId,
            ...(clientState === null ? {} : { clientState }),
          });
          if (outcome !== "accepted") {
            logger.warn({ subscriptionId, outcome }, "Graph webhook notification rejected");
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
