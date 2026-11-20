import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { handleGoogleCalendarNotification, handleGraphCalendarNotification } from "@semprec/data";
import { runAsSystem } from "@semprec/shared";
import { NO_STORE, PayloadTooLargeError, readRawBody, sendJson } from "./adapter/http.js";
import { logger } from "./logger.js";

export const GOOGLE_CALENDAR_WEBHOOK_PATH = "/api/calendar/google/webhook";
export const GRAPH_CALENDAR_WEBHOOK_PATH = "/api/calendar/graph/webhook";

/** Google sends its notifications with an empty body; anything larger is refused unread. */
const MAX_GOOGLE_BODY_BYTES = 16 * 1024;
/** Generous for a real Graph batch, but bounds a malicious POST. */
const MAX_GRAPH_BODY_BYTES = 256 * 1024;
/** Notifications of one Graph batch acted on; Graph sends far fewer. */
const MAX_GRAPH_NOTIFICATIONS = 100;
const MAX_GRAPH_ID_LENGTH = 256;
const MAX_SECRET_LENGTH = 256;
const MAX_VALIDATION_TOKEN_LENGTH = 1024;
/** Google's channel id alphabet and length; this server's ids are UUIDs. */
const GOOGLE_CHANNEL_ID = /^[A-Za-z0-9\-_+/=]{1,64}$/;

function singleHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === "string" ? value : null;
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { "Cache-Control": NO_STORE });
  res.end();
}

/** Confines an escaped rejection to a 500 for this request instead of an unhandled rejection ending the process. */
function safely(name: string, handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handle(req, res).catch((err: unknown) => {
      logger.error({ errorName: err instanceof Error ? err.name : typeof err }, `Unhandled error in the ${name}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}

/**
 * `POST /api/calendar/google/webhook`, unauthenticated by design: Google is the caller, and the channel token it
 * sends back (a random secret stored per channel, compared in constant time) is the check. A valid notification
 * answers 200 and queues the account's sync pass; an unknown channel, a wrong or missing token and a malformed
 * channel id all answer the same 404 and queue nothing.
 */
export function createGoogleCalendarWebhookRequestListener(pool: Pool) {
  return safely("Google Calendar webhook listener", async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    try {
      await readRawBody(req, { maxBytes: MAX_GOOGLE_BODY_BYTES });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      throw err;
    }
    const channelId = singleHeader(req, "x-goog-channel-id");
    const token = singleHeader(req, "x-goog-channel-token");
    if (channelId === null || !GOOGLE_CHANNEL_ID.test(channelId) || (token?.length ?? 0) > MAX_SECRET_LENGTH) {
      sendEmpty(res, 404);
      return;
    }
    const outcome = await runAsSystem("google-calendar-webhook", () =>
      handleGoogleCalendarNotification(pool, {
        channelId,
        token,
        resourceState: singleHeader(req, "x-goog-resource-state"),
      }),
    );
    if (outcome !== "accepted") {
      logger.warn({ outcome }, "Google Calendar webhook notification rejected");
      sendEmpty(res, 404);
      return;
    }
    sendEmpty(res, 200);
  });
}

interface RawGraphNotification {
  subscriptionId: string;
  clientState: string | null;
}

/** A Graph notification carries other fields this receiver does not act on. */
function parseGraphNotification(value: unknown): RawGraphNotification | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { subscriptionId, clientState } = record;
  if (typeof subscriptionId !== "string" || !subscriptionId || subscriptionId.length > MAX_GRAPH_ID_LENGTH) {
    return undefined;
  }
  return {
    subscriptionId,
    clientState: typeof clientState === "string" && clientState.length <= MAX_SECRET_LENGTH ? clientState : null,
  };
}

/**
 * `POST /api/calendar/graph/webhook`, unauthenticated by design: Microsoft Graph is the caller, and each
 * notification's `clientState` (compared in constant time) is the check. The validation handshake
 * (`?validationToken=`) is answered first with the literal token as `text/plain`, which Graph matches byte for byte.
 * A batch answers 202 whatever its notifications' outcomes, because Graph drops a subscription whose endpoint keeps
 * failing; rejected ones are logged and queue nothing.
 */
export function createGraphCalendarWebhookRequestListener(pool: Pool) {
  return safely("Graph calendar webhook listener", async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const validationToken = new URL(req.url ?? "/", "http://localhost").searchParams.get("validationToken");
    if (validationToken !== null) {
      if (validationToken.length > MAX_VALIDATION_TOKEN_LENGTH) {
        sendJson(res, 400, { error: "validationToken is too long" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": NO_STORE,
        "X-Content-Type-Options": "nosniff",
      });
      res.end(validationToken);
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRawBody(req, { maxBytes: MAX_GRAPH_BODY_BYTES });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      sendJson(res, 400, { error: "Request body is not valid JSON" });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      sendJson(res, 400, { error: "Request body must be a JSON object" });
      return;
    }
    const rawValue = (parsed as Record<string, unknown>).value;
    const notifications = Array.isArray(rawValue)
      ? rawValue
          .slice(0, MAX_GRAPH_NOTIFICATIONS)
          .map(parseGraphNotification)
          .filter((notification): notification is RawGraphNotification => notification !== undefined)
      : [];

    await runAsSystem("graph-calendar-webhook", async () => {
      for (const notification of notifications) {
        const outcome = await handleGraphCalendarNotification(pool, notification);
        if (outcome !== "accepted") logger.warn({ outcome }, "Graph calendar webhook notification rejected");
      }
    });
    sendEmpty(res, 202);
  });
}
