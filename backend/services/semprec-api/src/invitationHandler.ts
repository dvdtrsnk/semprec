import type { IncomingMessage, ServerResponse } from "node:http";
import { acceptInvitation, ChokePointError, NotFoundError, ValidationError } from "@semprec/data";
import type { Pool } from "pg";
import { toPublicErrorBody } from "./adapter/errorContract.js";
import { PayloadTooLargeError, readJsonBody, sendJson } from "./adapter/http.js";
import { clientIpFromRequest } from "./clientIp.js";
import { createClientIpThrottle, type ClientIpThrottle, type ThrottleReservation } from "./clientIpThrottle.js";
import { logger } from "./logger.js";

export interface InvitationRequestListenerOptions {
  /** Read the throttle key from the last `X-Forwarded-For` hop (see `clientIpFromRequest`). */
  trustProxy: boolean;
  /** Per-client-address throttle; defaults to one fresh limiter per listener. */
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
 * The body's `token` and `password`, both non-empty strings, and its optional `displayName`, which
 * `acceptInvitation` validates before any lookup; anything else is a 400 naming the field.
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
 * Handles `POST /api/invitations/accept` (issue #1087), the one way to create an account besides
 * `POST /api/setup`. There is no session yet, so the single-use invitation token is the credential:
 * an unusable token gets the same 404 whatever the reason (`acceptInvitation`), and the route never
 * reveals which one applied.
 *
 * Per client address, under the `invitationAccept` limit of `clientIpThrottle.ts` (the limiter type
 * `authHandler.ts` also uses for login and password reset): a request over the limit is answered 429
 * before its body is read. In-flight requests hold reservations; completed unusable tokens remain
 * counted, while validation failures, oversized bodies, successes and unexpected failures release them.
 */
export function createInvitationRequestListener(pool: Pool, options: InvitationRequestListenerOptions) {
  const clientIpThrottle = options.clientIpThrottle ?? createClientIpThrottle();

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method === "POST" && url.pathname === ACCEPT_PATH) {
        const ip = clientIpFromRequest(req, { trustProxy: options.trustProxy });
        // Check and count in one synchronous step, so concurrent requests from one address cannot all pass
        // the check before any is counted; the reservation is released for an outcome that must not count.
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
      // The error's name only: an error's message can carry user content, such as an address or a token.
      logger.error(
        { errorName: errorName(err), method: req.method, path: url.pathname },
        "Unexpected error handling request",
      );
      sendJson(res, 500, { error: "Internal server error" });
    }
  }

  /**
   * Same rationale as `setupHandler.ts`: a synchronous boundary confines a rejection that escapes the
   * try/catch to a 500 for that one request, instead of an unhandled rejection that ends the process.
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
