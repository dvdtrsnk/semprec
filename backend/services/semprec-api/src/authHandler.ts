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
  SESSION_TTL_SECONDS,
  SESSION_PLATFORMS,
  type SessionPlatform,
  type AuthenticatedIdentity,
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

/** Prefers the `Authorization: Bearer` header (native clients), falling back to the web session cookie. */
function extractToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    return token.length > 0 ? token : null;
  }
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  return parseCookieHeader(cookieHeader)[SESSION_COOKIE_NAME] ?? null;
}

function sessionCookieHeader(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/**
 * The one path from an HTTP request to a verified session, shared by this handler's own
 * `GET /api/auth/session`/`logout`/`revoke` routes and (per issue #143) every other route that
 * adopts auth. Throws `UnauthorizedError` for a missing, invalid, expired, or revoked token
 * alike — callers should let that propagate to a generic 401, never inspect it further.
 */
export async function authenticateRequest(pool: Pool, req: IncomingMessage): Promise<AuthenticatedIdentity> {
  const token = extractToken(req);
  if (!token) throw new UnauthorizedError();
  return withTransaction(pool, (client) => verifySessionToken(client, token));
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

/**
 * Auth-v1's HTTP surface (issue #140): `POST /api/auth/login`, `POST /api/auth/logout`,
 * `POST /api/auth/sessions/:id/revoke`, and `GET /api/auth/session`. Unlike this package's other
 * handlers, there is no shared-secret `authToken` gate here — `login` is necessarily public, and
 * the other three routes gate on a real session via `authenticateRequest` instead.
 *
 * `SESSION_COOKIE_NAME` is one of two ways a request can carry its token; the other is
 * `Authorization: Bearer` (native clients, or a web client that prefers not to rely on cookies).
 * `login`'s response always includes the raw token in its JSON body so both kinds of client can
 * use it, and additionally sets it as a cookie so a browser client doesn't have to.
 */
export function createAuthRequestListener(pool: Pool) {
  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

        sendJson(
          res,
          200,
          { token: result.token, user: result.user },
          { "Set-Cookie": sessionCookieHeader(result.token, SESSION_TTL_SECONDS) },
        );
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
        const [, sessionId] = revokeMatch;
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
  };
}
