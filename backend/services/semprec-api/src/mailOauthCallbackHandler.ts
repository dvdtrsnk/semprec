import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./adapter/http.js";

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

/**
 * Public by design: the browser arrives from the provider. The handler takes no pool, reads no
 * cookie or `Authorization`, writes and logs nothing. It answers `{ state, code }`, which the app
 * hands to the authenticated `POST /api/mail/mailboxes/oauth/complete`, where the state is verified
 * against the signed-in user. A provider error (e.g. cancelled consent) answers `{ state,
 * providerError }`; the app then starts a new sign-in and the unused state expires. A malformed
 * `state` or `error`, or neither `error` nor a bounded `code`, is 400 `validation_failed`.
 */
export function createMailOauthCallbackRequestListener() {
  return function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    const state = query.get("state");
    if (state === null || !STATE_PATTERN.test(state)) {
      refuse(res);
      return;
    }
    const providerError = query.get("error");
    if (providerError !== null) {
      if (!PROVIDER_ERROR_PATTERN.test(providerError)) {
        refuse(res);
        return;
      }
      sendJson(res, 200, { state, providerError }, RESPONSE_HEADERS);
      return;
    }
    const code = query.get("code");
    if (code === null || code.length === 0 || code.length > MAX_CODE_LENGTH) {
      refuse(res);
      return;
    }
    sendJson(res, 200, { state, code }, RESPONSE_HEADERS);
  };
}
