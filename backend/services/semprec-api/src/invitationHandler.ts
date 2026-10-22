import type { IncomingMessage, ServerResponse } from "node:http";
import { ChokePointError, NotFoundError, ValidationError, acceptInvitation } from "@semprec/data";
import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { toPublicErrorBody } from "./adapter/errorContract.js";
import { PayloadTooLargeError, readJsonBody, sendJson } from "./adapter/http.js";
import { clientIpFromRequest } from "./clientIp.js";
import { createClientIpThrottle, type ClientIpThrottle } from "./clientIpThrottle.js";
import { logger } from "./logger.js";

export interface InvitationRequestListenerOptions {
  /** Read the throttle key from the last `X-Forwarded-For` hop instead of the socket peer (see `clientIpFromRequest`). */
  trustProxy: boolean;
  /** Per-client-address throttle; defaults to one fresh limiter per listener. */
  clientIpThrottle?: ClientIpThrottle;
}

const MAX_BODY_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The error's name and a string `code` when it has one — never its message, which can carry input. */
function describeError(err: unknown): { errorName: string; code?: string } {
  const errorName = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? { errorName, code } : { errorName };
}

/**
 * Handles `POST /api/invitations/accept` (issue #1087), the only route that creates an account
 * after the first one. Public by design: the invitee has no session yet, and the single-use token
 * in the body is the credential. Every unusable token answers the same 404 (`acceptInvitation`).
 *
 * Throttled per client address under `invitationAccept` (#1073): an address over the limit gets 429
 * before its body is read, and only a rejected token (a `NotFoundError`) counts toward the limit, so
 * a malformed request or a successful acceptance never does. Nothing that is logged carries the
 * token, the email or the password.
 */
export function createInvitationRequestListener(pool: Pool, options: InvitationRequestListenerOptions) {
  const clientIpThrottle = options.clientIpThrottle ?? createClientIpThrottle();

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method === "POST" && url.pathname === "/api/invitations/accept") {
        const ip = clientIpFromRequest(req, { trustProxy: options.trustProxy });
        const retryAfter = clientIpThrottle.retryAfterSeconds("invitationAccept", ip);
        if (retryAfter !== null) {
          sendJson(
            res,
            429,
            { error: "Too many attempts; try again later", code: "rate_limited" },
            { "Retry-After": String(retryAfter) },
          );
          return;
        }

        const body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
        if (!isRecord(body)) throw new ValidationError("Request body must be a JSON object");
        const { token, password } = body;
        if (typeof token !== "string" || token.length === 0) {
          throw new ValidationError("'token' must be a non-empty string");
        }
        if (typeof password !== "string" || password.length === 0) {
          throw new ValidationError("'password' must be a non-empty string");
        }

        let user: Awaited<ReturnType<typeof acceptInvitation>>;
        try {
          user = await acceptInvitation(pool, { token, password });
        } catch (err) {
          if (err instanceof NotFoundError) clientIpThrottle.record("invitationAccept", ip);
          throw err;
        }
        sendJson(res, 200, { user });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { error: err.message });
        return;
      }
      if (err instanceof ChokePointError) {
        sendJson(res, err.status, toPublicErrorBody(err));
        return;
      }
      logger.error(
        { ...describeError(err), method: req.method, path: url.pathname },
        "Unexpected error handling request",
      );
      sendJson(res, 500, { error: "Internal server error" });
    }
  }

  /**
   * Same rationale as `setupHandler.ts`'s `handleRequestSafely`: keeping the boundary synchronous
   * confines a rejection that escapes the try/catch above to a 500 for that one request instead
   * of an unhandled rejection that takes the whole process down.
   */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    // The route touches only global identity tables until the new tenant is provisioned, which
    // `acceptInvitation` does inside that tenant's own scope.
    runAsSystem("invitation-acceptance", () => handleRequest(req, res)).catch((err: unknown) => {
      logger.error(describeError(err), "Unhandled error in the invitation request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
