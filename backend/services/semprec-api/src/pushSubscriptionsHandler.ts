import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  withTransaction,
  ChokePointError,
  ValidationError,
  registerPushSubscription,
  revokePushSubscription,
} from "@semprec/data";
import { authenticateRequest } from "./authHandler.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

const MAX_BODY_BYTES = 64 * 1024;

class PayloadTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new PayloadTooLargeError("Request body exceeds the maximum allowed size");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return parsed;
}

const REVOKE_PUSH_SUBSCRIPTION_PATH = /^\/api\/push-subscriptions\/([^/]+)\/revoke$/;

/**
 * Issue #150's authenticated lifecycle endpoints: `POST /api/push-subscriptions` (register or
 * reactivate) and `POST /api/push-subscriptions/:id/revoke` (explicit revocation). Both require
 * a live session via `authenticateRequest`, same as every other non-public route (#143's route
 * matrix); registration binds the new row to the caller's own `session.id` so the logout/remote
 * revocation cascade in `authActions.ts` can find it later.
 */
export function createPushSubscriptionsRequestListener(pool: Pool) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method === "POST" && url.pathname === "/api/push-subscriptions") {
        const identity = await authenticateRequest(pool, req);
        const body = (await readJsonBody(req)) as Record<string, unknown>;

        const subscription = await withTransaction(pool, (client) =>
          registerPushSubscription(client, {
            userId: identity.user.id,
            sessionId: identity.session.id,
            channel: body.channel,
            platform: body.platform,
            endpoint: body.endpoint,
            p256dh: body.p256dh,
            authSecret: body.authSecret,
            deviceToken: body.deviceToken,
            apnsEnvironment: body.apnsEnvironment,
          }),
        );
        sendJson(res, 200, { subscription });
        return;
      }

      const revokeMatch = url.pathname.match(REVOKE_PUSH_SUBSCRIPTION_PATH);
      if (req.method === "POST" && revokeMatch) {
        const identity = await authenticateRequest(pool, req);
        // Group 1 of REVOKE_PUSH_SUBSCRIPTION_PATH is not optional, so a successful match always
        // captured it; a runtime check here would be unreachable code.
        const subscriptionId = revokeMatch[1]!;
        const revoked = await withTransaction(pool, (client) =>
          revokePushSubscription(client, identity.user.id, subscriptionId),
        );
        sendJson(res, 200, { revoked });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, { error: err.message, code: err.code, details: err.details });
        return;
      }
      console.error(`Unexpected error in ${req.method} ${url.pathname}:`, err);
      sendJson(res, 500, { error: "Internal server error" });
    }
  }

  // Same synchronous-boundary rationale as `authHandler.ts`'s `handleRequestSafely`: an async
  // listener would turn an escaping rejection into an unhandled rejection that kills the process.
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
