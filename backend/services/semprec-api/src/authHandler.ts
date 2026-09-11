import type { IncomingMessage, ServerResponse } from "node:http";
import {
  withTransaction,
  ChokePointError,
  ValidationError,
  UnauthorizedError,
  login,
  logout,
  verifySessionToken,
  revokeUserSession,
  requestPasswordReset,
  resetPassword,
  SESSION_TTL_SECONDS,
  SESSION_PLATFORMS,
  SESSION_DELIVERY_CHANNEL_BY_PLATFORM,
  type SessionPlatform,
  type SessionDeliveryChannel,
  type AuthenticatedIdentity,
  type PasswordResetMailer,
} from "@semprec/data";
import type { Pool } from "pg";

/** Name of the cookie a web client's login response carries the session token in. */
export const SESSION_COOKIE_NAME = "semprec_session";

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(payload);
}

function parseCookieHeader(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;
    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

/**
 * Prefers the `Authorization: Bearer` header (native clients), falling back to the web session
 * cookie. Reports which channel supplied the token alongside it, so the caller can reject a
 * token presented over a channel its platform doesn't use (see `SESSION_DELIVERY_CHANNEL_BY_PLATFORM`).
 */
function extractToken(req: IncomingMessage): { token: string; channel: SessionDeliveryChannel } | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    return token.length > 0 ? { token, channel: "bearer" } : null;
  }
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const token = parseCookieHeader(cookieHeader)[SESSION_COOKIE_NAME];
  return token ? { token, channel: "cookie" } : null;
}

function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/**
 * The one path from an HTTP request to a verified session, shared by this handler's own
 * `GET /api/auth/session`/`logout`/`revoke` routes and (per issue #143) every other route that
 * adopts auth. Throws `UnauthorizedError` for a missing, invalid, expired, or revoked token, or
 * one presented over a channel its platform doesn't use (a web session via `Bearer`, or a native
 * session via cookie) — callers should let that propagate to a generic 401, never inspect it
 * further; a mismatched channel gets the same opaque failure as a garbage token.
 */
export async function authenticateRequest(pool: Pool, req: IncomingMessage): Promise<AuthenticatedIdentity> {
  const presented = extractToken(req);
  if (!presented) throw new UnauthorizedError();
  const identity = await withTransaction(pool, (client) => verifySessionToken(client, presented.token));
  if (SESSION_DELIVERY_CHANNEL_BY_PLATFORM[identity.session.platform] !== presented.channel) {
    throw new UnauthorizedError();
  }
  return identity;
}

function isSessionPlatform(value: unknown): value is SessionPlatform {
  return typeof value === "string" && (SESSION_PLATFORMS as readonly string[]).includes(value);
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("Request body is not valid JSON");
  }
}

const REVOKE_SESSION_PATH = /^\/api\/auth\/sessions\/([^/]+)\/revoke$/;

export interface AuthRequestListenerOptions {
  /** Sends the reset link email; issue #142's SMTP path. */
  passwordResetMailer: PasswordResetMailer;
  /** Origin the emailed password-reset link is built against, e.g. `https://app.semprec.example`. */
  appBaseUrl: string;
}

/**
 * Auth-v1's HTTP surface (issue #140): `POST /api/auth/login`, `POST /api/auth/logout`,
 * `POST /api/auth/sessions/:id/revoke`, `GET /api/auth/session`, and (issue #142)
 * `POST /api/auth/password-reset/request` / `POST /api/auth/password-reset/consume`. Unlike this
 * package's other handlers, there is no shared-secret `authToken` gate here — `login` and the
 * password-reset routes are necessarily public, and the session routes gate on a real session
 * via `authenticateRequest` instead.
 *
 * `SESSION_COOKIE_NAME` is one of two ways a request can carry its token; the other is
 * `Authorization: Bearer` (native clients only, per `SESSION_DELIVERY_CHANNEL_BY_PLATFORM`).
 * A `web` login gets its token only via the `Set-Cookie` header — the JSON body omits it, so it
 * is never readable from page JavaScript — while `ios`/`macos` logins get it in the JSON body for
 * Keychain storage and no cookie at all. `authenticateRequest` rejects a token presented over the
 * other channel from the one its platform declared at login.
 */
export function createAuthRequestListener(pool: Pool, options: AuthRequestListenerOptions) {
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method === "POST" && url.pathname === "/api/auth/login") {
        const body = (await readJsonBody(req)) as { email?: unknown; password?: unknown; platform?: unknown };
        if (typeof body.email !== "string" || body.email.length === 0) {
          throw new ValidationError("'email' must be a non-empty string");
        }
        if (typeof body.password !== "string" || body.password.length === 0) {
          throw new ValidationError("'password' must be a non-empty string");
        }
        if (!isSessionPlatform(body.platform)) {
          throw new ValidationError(`'platform' must be one of: ${SESSION_PLATFORMS.join(", ")}`);
        }

        const userAgentHeader = req.headers["user-agent"];
        const result = await withTransaction(pool, (client) =>
          login(client, {
            email: body.email as string,
            password: body.password as string,
            platform: body.platform as SessionPlatform,
            ip: req.socket.remoteAddress ?? "0.0.0.0",
            userAgent: typeof userAgentHeader === "string" ? userAgentHeader : null,
          }),
        );

        // Per #141: a browser must never see its token in a readable response body — only the
        // `httpOnly` cookie carries it. iOS/macOS get it back in the body for Keychain storage
        // and use it as `Authorization: Bearer` on every later request; they get no cookie.
        if (body.platform === "web") {
          sendJson(
            res,
            200,
            { user: result.user },
            { "Set-Cookie": sessionCookieHeader(result.token, SESSION_TTL_SECONDS) },
          );
        } else {
          sendJson(res, 200, { token: result.token, user: result.user });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/password-reset/request") {
        const body = (await readJsonBody(req)) as { email?: unknown };
        if (typeof body.email !== "string" || body.email.length === 0) {
          throw new ValidationError("'email' must be a non-empty string");
        }

        // Always 200 with the same body regardless of whether `email` matched an account —
        // issue #142's "request responses do not disclose whether an email exists".
        await requestPasswordReset(pool, options.passwordResetMailer, {
          email: body.email,
          appBaseUrl: options.appBaseUrl,
        });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/password-reset/consume") {
        const body = (await readJsonBody(req)) as { token?: unknown; newPassword?: unknown };
        if (typeof body.token !== "string" || body.token.length === 0) {
          throw new ValidationError("'token' must be a non-empty string");
        }
        if (typeof body.newPassword !== "string" || body.newPassword.length === 0) {
          throw new ValidationError("'newPassword' must be a non-empty string");
        }

        await withTransaction(pool, (client) =>
          resetPassword(client, { token: body.token as string, newPassword: body.newPassword as string }),
        );
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/logout") {
        const identity = await authenticateRequest(pool, req);
        await withTransaction(pool, (client) => logout(client, identity.session.id));
        sendJson(res, 200, { ok: true }, { "Set-Cookie": CLEAR_SESSION_COOKIE });
        return;
      }

      const revokeMatch = url.pathname.match(REVOKE_SESSION_PATH);
      if (req.method === "POST" && revokeMatch) {
        const identity = await authenticateRequest(pool, req);
        // Group 1 of REVOKE_SESSION_PATH is not optional, so a successful match always
        // captured it; a runtime check here would be unreachable code.
        const sessionId = revokeMatch[1]!;
        const revoked = await withTransaction(pool, (client) => revokeUserSession(client, identity.user.id, sessionId));
        sendJson(res, 200, { revoked });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/auth/session") {
        const identity = await authenticateRequest(pool, req);
        sendJson(res, 200, {
          user: identity.user,
          session: { id: identity.session.id, platform: identity.session.platform },
        });
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

  /**
   * `http.createServer` discards its listener's return value, so an `async` listener turns any
   * rejection escaping the try/catch above into an unhandled rejection — which Node answers by
   * exiting the process. Keeping the boundary synchronous confines it to a 500 for the one
   * request. Same shape as `setupHandler.ts`.
   */
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
