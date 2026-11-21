import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { resolveMailOauthRedirectUrl } from "@semprec/data";
import { NO_STORE, sendJson } from "./adapter/http.js";
import { clientIpFromRequest } from "./clientIp.js";
import { createClientIpThrottle, type ClientIpThrottle } from "./clientIpThrottle.js";
import { logger } from "./logger.js";

export interface MailOauthCallbackRequestListenerOptions {
  /** Read the throttle key from the last `X-Forwarded-For` hop. */
  trustProxy: boolean;
  /** Defaults to one fresh limiter per listener. */
  clientIpThrottle?: ClientIpThrottle;
}

/** Matches the redirect URI `mail/mailOauthRouteHandlers.ts` builds. */
export const MAIL_OAUTH_CALLBACK_PATH = "/api/mail/oauth/callback";

/** Our states are 43 characters; the cap only bounds what is echoed. */
const STATE_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
/** The code is opaque to this server, so only its length is bounded. */
const MAX_CODE_LENGTH = 4096;
/** An OAuth `error` value is a short lowercase token (RFC 6749 §4.1.2.1), never free text. */
const PROVIDER_ERROR_PATTERN = /^[a-z_]{1,64}$/;

/**
 * The browser must take the body as data, and the URL (which holds the code) goes into no `Referer`
 * header.
 */
const RESPONSE_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

function refuse(res: ServerResponse): void {
  sendJson(res, 400, { error: { code: "validation_failed" } }, RESPONSE_HEADERS);
}

type CallbackAnswer = { state: string; code: string } | { state: string; providerError: string };

/** The query after validation, or `null` for a request answered 400. */
function parseCallback(req: IncomingMessage): CallbackAnswer | null {
  const query = new URL(req.url ?? "/", "http://localhost").searchParams;
  const state = query.get("state");
  if (state === null || !STATE_PATTERN.test(state)) return null;
  const providerError = query.get("error");
  if (providerError !== null) {
    return PROVIDER_ERROR_PATTERN.test(providerError) ? { state, providerError } : null;
  }
  const code = query.get("code");
  if (code === null || code.length === 0 || code.length > MAX_CODE_LENGTH) return null;
  return { state, code };
}

/**
 * Public by design: the browser arrives from the provider. The handler reads no cookie or `Authorization`, writes and
 * logs nothing but a failure's name. It answers `{ state, code }`, which the app hands to the authenticated
 * `POST /api/mail/mailboxes/oauth/complete`, where the state is verified against the signed-in user. A provider error
 * (e.g. cancelled consent) answers `{ state, providerError }`; the app then starts a new sign-in and the unused state
 * expires. A malformed `state` or `error`, or neither `error` nor a bounded `code`, is 400 `validation_failed` before
 * any database read.
 *
 * Every request counts under `mailOauthCallback` per client address, first of all; over the limit it answers 429
 * `rate_limited` with `Retry-After` and reads nothing.
 *
 * When the open state names a redirect target (`redirectTarget: "app"` at start), the same values go to that target
 * as a 302 instead: `semprec://oauth?state=…&code=…`, or `…&error=…`. The target URL comes from the stored state
 * only (`resolveMailOauthRedirectUrl`), never from the request.
 */
export function createMailOauthCallbackRequestListener(pool: Pool, options: MailOauthCallbackRequestListenerOptions) {
  const clientIpThrottle = options.clientIpThrottle ?? createClientIpThrottle();

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = clientIpFromRequest(req, { trustProxy: options.trustProxy });
    const acquisition = clientIpThrottle.tryAcquire("mailOauthCallback", ip);
    if (!acquisition.granted) {
      sendJson(
        res,
        429,
        { error: { code: "rate_limited" } },
        { ...RESPONSE_HEADERS, "Retry-After": String(acquisition.retryAfterSeconds) },
      );
      return;
    }
    const answer = parseCallback(req);
    if (answer === null) {
      refuse(res);
      return;
    }
    const redirectUrl = await resolveMailOauthRedirectUrl(pool, answer.state);
    if (redirectUrl === null) {
      sendJson(res, 200, answer, RESPONSE_HEADERS);
      return;
    }
    const location = new URL(redirectUrl);
    location.search = new URLSearchParams(
      "code" in answer
        ? { state: answer.state, code: answer.code }
        : { state: answer.state, error: answer.providerError },
    ).toString();
    res.writeHead(302, { ...RESPONSE_HEADERS, Location: location.toString(), "Cache-Control": NO_STORE });
    res.end();
  }

  /** Confines a failed state lookup to a 500 for this request instead of an unhandled rejection. */
  return function handleRequestSafely(req: IncomingMessage, res: ServerResponse): void {
    handleRequest(req, res).catch((err: unknown) => {
      // The error's message can carry database or connection text; its name and code cannot.
      const name = err instanceof Error ? err.name : typeof err;
      const code = err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
      logger.error({ errorName: name, errorCode: code }, "Mail OAuth callback failed");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: { code: "internal_error" } }, RESPONSE_HEADERS);
    });
  };
}
