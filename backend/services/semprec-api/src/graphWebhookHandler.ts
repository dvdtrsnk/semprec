import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { handleGraphChangeNotification } from "@semprec/data";
import { logger } from "./logger.js";

/** Generous for a real Graph delivery (Graph itself caps a single batch around 20 notifications), but bounds a misbehaving or malicious POST from buffering an unbounded body before this handler ever looks at it — same discipline as `setupHandler.ts`'s `MAX_BODY_BYTES`. */
const MAX_BODY_BYTES = 256 * 1024;

class PayloadTooLargeError extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError("Request body exceeds the maximum allowed size");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

interface RawNotification {
  subscriptionId: string;
  clientState?: string;
}

/** Validates only the two fields this receiver reads — a Graph notification carries several other fields (`resourceData`, `changeType`, `tenantId`, ...) this issue's Task never asks this endpoint to act on beyond handing off to the existing reconcile job. */
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
 * Handles `POST /api/mail/graph/webhook` (issue #198) — Microsoft Graph's single combined
 * validation-handshake and change-notification endpoint. Unauthenticated by design: Graph itself
 * is the only caller, and there is no session to require here — safety instead comes from each
 * notification's `clientState` (checked in constant time by `handleGraphChangeNotification`), not
 * a bearer token. `routeMatrix.ts` (issue #143) lists it among the documented public exceptions.
 *
 * Graph's validation handshake ("echo validation token within three seconds," this issue's
 * acceptance criteria — Graph's own spec allows up to 10s) is handled first and unconditionally:
 * a subscription create/renew POSTs `?validationToken=<token>` with a body that is not the JSON
 * notification batch shape, so it must never fall through to body parsing below. The response is
 * the literal token text as `text/plain`, nothing else — Graph matches it byte-for-byte.
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
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(validationToken);
      return;
    }

    try {
      const raw = await readBody(req);
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

      for (const notification of notifications) {
        const outcome = await handleGraphChangeNotification(pool, notification);
        if (outcome !== "accepted") {
          logger.warn({ subscriptionId: notification.subscriptionId, outcome }, "Graph webhook notification rejected");
        }
      }

      // 202 regardless of individual notification outcomes: Graph disables (and eventually stops
      // retrying) a subscription whose endpoint doesn't answer promptly with a 2xx — a rejected
      // notification is this receiver's own problem to log and drop, not something that should
      // make Graph think delivery itself failed and needs to be redelivered.
      res.writeHead(202);
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

  /** Same rationale as `setupHandler.ts`'s `handleRequestSafely`: keeps a rejection that escapes the try/catch above confined to a 500 for that one request instead of an unhandled rejection taking the whole process down. */
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
