import type { IncomingMessage, ServerResponse } from "node:http";
import { acceptInvitation, ChokePointError, NotFoundError, ValidationError } from "@semprec/data";
import type { Pool } from "pg";
import { toPublicErrorBody } from "./adapter/errorContract.js";
import { PayloadTooLargeError, readJsonBody, sendJson } from "./adapter/http.js";
import { clientIpFromRequest } from "./clientIp.js";
import { createClientIpThrottle, type ClientIpThrottle, type ThrottleReservation } from "./clientIpThrottle.js";
import { logger } from "./logger.js";

export interface InvitationRequestListenerOptions {
  /** Read the throttle key from the last `X-Forwarded-For` hop. */
  trustProxy: boolean;
  /** Defaults to one fresh limiter per listener. */
  clientIpThrottle?: ClientIpThrottle;
}

const MAX_BODY_BYTES = 64 * 1024;
const ACCEPT_PATH = "/api/invitations/accept";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * `acceptInvitation` validates `displayName` before any lookup; anything else is a 400 naming the
 * field.
 */
function parseAcceptBody(raw: unknown): { token: string; password: string; displayName: unknown } {
  if (!isRecord(raw)) throw new ValidationError("Request body must be a JSON object");
  const { token, password, displayName } = raw;
  if (typeof token !== "string" || token.length === 0) {
    throw new ValidationError("'token' must be a non-empty string", { field: "token" });
  }
  if (typeof password !== "string" || password.length === 0) {
    throw new ValidationError("'password' must be a non-empty string", { field: "password" });
  }
  return { token, password, displayName };
}

/**
 * The one way besides `POST /api/setup` to create an account. With no session, the single-use token
 * is the credential: an unusable token gets the same 404 whatever the reason.
 *
 * Throttled per client address under `invitationAccept`; over the limit answers 429 before the body
 * is read. Completed unusable tokens stay counted; validation failures, oversized bodies, successes
 * and unexpected failures release their reservation.
 */
export function createInvitationRequestListener(pool: Pool, options: InvitationRequestListenerOptions) {
  const clientIpThrottle = options.clientIpThrottle ?? createClientIpThrottle();

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method === "POST" && url.pathname === ACCEPT_PATH) {
        const ip = clientIpFromRequest(req, { trustProxy: options.trustProxy });
        // Check and count in one synchronous step, so concurrent requests cannot all pass before
        // any is counted.
        const acquisition = clientIpThrottle.tryAcquire("invitationAccept", ip);
        if (!acquisition.granted) {
          sendJson(
            res,
            429,
            { error: "Too many attempts; try again later", code: "rate_limited" },
            { "Retry-After": String(acquisition.retryAfterSeconds) },
          );
          return;
        }
        const reservation: ThrottleReservation = acquisition.reservation;
        let user: Awaited<ReturnType<typeof acceptInvitation>>;
        try {
          const body = parseAcceptBody(await readJsonBody(req, { maxBytes: MAX_BODY_BYTES }));
          user = await acceptInvitation(pool, body);
        } catch (err) {
          if (!(err instanceof NotFoundError)) reservation.release();
          throw err;
        }
        reservation.release();
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
      // The error's name only: its message can carry user content, such as an address or a token.
      logger.error(
        { errorName: errorName(err), method: req.method, path: url.pathname },
        "Unexpected error handling request",
      );
      sendJson(res, 500, { error: "Internal server error" });
    }
  }

  /**
   * Confines an escaped rejection to a 500 for this request instead of an unhandled rejection
   * ending the process.
   */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      logger.error({ errorName: errorName(err) }, "Unhandled error in the invitation request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
