import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./adapter/http.js";

/** The redirect target of the mailbox sign-in, as `mail/mailOauthRouteHandlers.ts` in `@semprec/data` builds the redirect URI. */
export const MAIL_OAUTH_CALLBACK_PATH = "/api/mail/oauth/callback";

/** Our states are 43 characters; the cap only bounds what is echoed. */
const STATE_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
/** An authorization code is opaque to this server, so only its length is bounded. */
const MAX_CODE_LENGTH = 4096;
/** An OAuth `error` value is a short lowercase token (RFC 6749 §4.1.2.1), never free text. */
const PROVIDER_ERROR_PATTERN = /^[a-z_]{1,64}$/;

/** A JSON body the browser must take as data, and whose address, which holds the code, goes into no `Referer` header. */
const RESPONSE_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

function refuse(res: ServerResponse): void {
  sendJson(res, 400, { error: { code: "validation_failed" } }, RESPONSE_HEADERS);
}

/**
 * Handles `GET /api/mail/oauth/callback` (issue gh-1686), the one address a Google or Microsoft
 * sign-in redirects the browser back to. Public by design: the browser arrives from the provider
 * and the app's session is not consulted. The handler takes no pool, reads no cookie or
 * `Authorization` header, writes nothing and logs nothing. It answers `{ state, code }`, which the
 * app hands to the authenticated `POST /api/mail/mailboxes/oauth/complete`; that route is what
 * verifies the state against the signed-in user. When the provider reported an error such as a
 * cancelled consent it answers `{ state, providerError }` instead. The complete route accepts no
 * such body, so the app calls nothing after it and starts a new sign-in; the unused state expires.
 * A request without a well-formed `state`, with a malformed `error`, or with neither an `error` nor
 * a bounded `code` answers 400 `validation_failed`.
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
