import type { IncomingMessage, ServerResponse } from "node:http";
import {
  withTransaction,
  getSelfPersonId,
  setSelfPersonId,
  ChokePointError,
  ValidationError,
  UnauthorizedError,
  PasswordResetTokenError,
  login,
  logout,
  verifySessionToken,
  revokeUserSession,
  revokeOtherUserSessions,
  listActiveSessionsForUser,
  requestPasswordReset,
  resetPassword,
  SESSION_MAX_LIFETIME_SECONDS,
  SESSION_PLATFORMS,
  SESSION_DELIVERY_CHANNEL_BY_PLATFORM,
  deviceFromUserAgent,
  type LoginDevice,
  type SessionDeviceKind,
  type SessionPlatform,
  type SessionDeliveryChannel,
  type AuthenticatedIdentity,
  type PasswordResetMailer,
} from "@semprec/data";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { toPublicErrorBody } from "./adapter/errorContract.js";
import { assertUuid } from "./adapter/requestValidation.js";
import { PayloadTooLargeError, readJsonBody, sendJson } from "./adapter/http.js";
import { clientIpFromRequest } from "./clientIp.js";
import {
  createClientIpThrottle,
  type ClientIpThrottle,
  type ThrottledAction,
  type ThrottleReservation,
} from "./clientIpThrottle.js";
import { logger } from "./logger.js";

/** Name of the cookie a web client's login response carries the session token in. */
export const SESSION_COOKIE_NAME = "semprec_session";

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
  // Authentication resolves the tenant, so it cannot run inside one: `runAsSystem` throws
  // `TenantScopeConflictError` from within a tenant scope.
  const identity = await runAsSystem("authenticate", () =>
    withTransaction(pool, (client) => verifySessionToken(client, presented.token)),
  );
  if (SESSION_DELIVERY_CHANNEL_BY_PLATFORM[identity.session.platform] !== presented.channel) {
    throw new UnauthorizedError();
  }
  return identity;
}

const NATIVE_DEVICE_KINDS: Record<"ios" | "macos", readonly SessionDeviceKind[]> = {
  ios: ["iphone", "ipad"],
  macos: ["mac"],
};

/** An optional trimmed string field of `1..maxLength` characters; an absent field yields `null`. */
function optionalDeviceString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined) return null;
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    throw new ValidationError(`'${field}' must be a string of 1-${maxLength} characters`, { field });
  }
  return trimmed;
}

/**
 * The device identity a login records. A browser must not be able to claim a device, so a `web`
 * login ignores every body field and takes the name and OS family from its `User-Agent`; a native
 * login's optional fields are validated and a violation is a 400 naming the field.
 */
function parseLoginDevice(
  raw: Record<string, unknown>,
  platform: SessionPlatform,
  userAgent: string | null,
): LoginDevice {
  if (platform === "web") {
    const derived = deviceFromUserAgent(userAgent);
    return {
      deviceId: null,
      deviceName: derived.deviceName,
      deviceKind: "browser",
      osVersion: derived.osVersion,
      appVersion: null,
    };
  }
  let deviceId: string | null = null;
  if (raw.deviceId !== undefined) {
    if (typeof raw.deviceId !== "string") {
      throw new ValidationError("'deviceId' must be a UUID string", { field: "deviceId" });
    }
    deviceId = assertUuid(raw.deviceId, "deviceId");
  }
  let deviceKind: SessionDeviceKind | null = null;
  if (raw.deviceKind !== undefined) {
    const allowed = NATIVE_DEVICE_KINDS[platform];
    const kind = allowed.find((candidate) => candidate === raw.deviceKind);
    if (!kind) {
      throw new ValidationError(`'deviceKind' must be one of: ${allowed.join(", ")}`, { field: "deviceKind" });
    }
    deviceKind = kind;
  }
  return {
    deviceId,
    deviceName: optionalDeviceString(raw.deviceName, "deviceName", 100),
    deviceKind,
    osVersion: optionalDeviceString(raw.osVersion, "osVersion", 50),
    appVersion: optionalDeviceString(raw.appVersion, "appVersion", 50),
  };
}

function isSessionPlatform(value: unknown): value is SessionPlatform {
  return typeof value === "string" && (SESSION_PLATFORMS as readonly string[]).includes(value);
}

const MAX_BODY_BYTES = 64 * 1024;

const REVOKE_SESSION_PATH = /^\/api\/auth\/sessions\/([^/]+)\/revoke$/;
/** Revokes every other session of the caller and keeps the calling one (issue #1650). */
const REVOKE_OTHER_SESSIONS_PATH = "/api/auth/sessions/revoke-others";

export interface AuthRequestListenerOptions {
  /** Sends the reset link email; issue #142's SMTP path. */
  passwordResetMailer: PasswordResetMailer;
  /** Origin the emailed password-reset link is built against, e.g. `https://app.semprec.example`. */
  appBaseUrl: string;
  /**
   * Read the login throttle key from the last `X-Forwarded-For` hop instead of the socket peer
   * (see `clientIpFromRequest`). Only safe behind a proxy that appends that hop; defaults to `false`.
   */
  trustProxy?: boolean;
  /** Per-client-address throttle for the public routes; defaults to one fresh limiter per listener. */
  clientIpThrottle?: ClientIpThrottle;
}

/**
 * Auth-v1's HTTP surface (issue #140): `POST /api/auth/login`, `POST /api/auth/logout`,
 * `POST /api/auth/sessions/:id/revoke`, `GET /api/auth/session`, `PUT /api/auth/self-person`, and (issue #142)
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
  const clientIpThrottle = options.clientIpThrottle ?? createClientIpThrottle();

  /**
   * Counts one event for `ip` under `action` and returns its reservation, or answers 429 and returns
   * `null` when the address is over the limit; callers return before reading the body. The check and
   * the count are one synchronous step, so concurrent requests from one address cannot all pass the
   * check before any is counted; a caller releases the reservation for an outcome that must not count.
   */
  function acquireOrRefuse(res: ServerResponse, action: ThrottledAction, ip: string): ThrottleReservation | null {
    const acquisition = clientIpThrottle.tryAcquire(action, ip);
    if (acquisition.granted) return acquisition.reservation;
    sendJson(
      res,
      429,
      { error: "Too many attempts; try again later", code: "rate_limited" },
      { "Retry-After": String(acquisition.retryAfterSeconds) },
    );
    return null;
  }

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      if (req.method === "POST" && url.pathname === "/api/auth/login") {
        const ip = clientIpFromRequest(req, { trustProxy: options.trustProxy ?? false });
        const reservation = acquireOrRefuse(res, "login", ip);
        if (!reservation) return;
        let body: { email: string; password: string; platform: SessionPlatform };
        let result: Awaited<ReturnType<typeof login>>;
        try {
          const raw = (await readJsonBody(req, { maxBytes: MAX_BODY_BYTES })) as {
            email?: unknown;
            password?: unknown;
            platform?: unknown;
            deviceId?: unknown;
            deviceName?: unknown;
            deviceKind?: unknown;
            osVersion?: unknown;
            appVersion?: unknown;
          };
          if (typeof raw.email !== "string" || raw.email.length === 0) {
            throw new ValidationError("'email' must be a non-empty string");
          }
          if (typeof raw.password !== "string" || raw.password.length === 0) {
            throw new ValidationError("'password' must be a non-empty string");
          }
          if (!isSessionPlatform(raw.platform)) {
            throw new ValidationError(`'platform' must be one of: ${SESSION_PLATFORMS.join(", ")}`);
          }
          body = { email: raw.email, password: raw.password, platform: raw.platform };

          const userAgentHeader = req.headers["user-agent"];
          const userAgent = typeof userAgentHeader === "string" ? userAgentHeader : null;
          const device = parseLoginDevice(raw, body.platform, userAgent);
          result = await login(pool, {
            email: body.email,
            password: body.password,
            platform: body.platform,
            // Throttle key (#635): the failure streak is scoped per (email, ip) and there is
            // deliberately no per-email aggregate lock — that would let an attacker from any address
            // lock the owner out everywhere. Per-address scoping only ever locks the attacker's own
            // address, and Argon2id verification keeps distributed guessing expensive.
            ip,
            userAgent,
            device,
          });
        } catch (err) {
          // Only a failed credential check counts; infrastructure errors and validation do not.
          if (!(err instanceof UnauthorizedError)) reservation.release();
          throw err;
        }
        reservation.release();

        // Public account fields and role; GET /api/auth/session also resolves the tenant-side person link.
        const user = { ...result.user, role: result.role };
        // Per #141: a browser must never see its token in a readable response body — only the
        // `httpOnly` cookie carries it. iOS/macOS get it back in the body for Keychain storage
        // and use it as `Authorization: Bearer` on every later request; they get no cookie.
        if (body.platform === "web") {
          sendJson(
            res,
            200,
            { user },
            { "Set-Cookie": sessionCookieHeader(result.token, SESSION_MAX_LIFETIME_SECONDS) },
          );
        } else {
          sendJson(res, 200, { token: result.token, user });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/password-reset/request") {
        const ip = clientIpFromRequest(req, { trustProxy: options.trustProxy ?? false });
        const reservation = acquireOrRefuse(res, "passwordResetRequest", ip);
        if (!reservation) return;
        let email: string;
        try {
          const body = (await readJsonBody(req, { maxBytes: MAX_BODY_BYTES })) as { email?: unknown };
          if (typeof body.email !== "string" || body.email.length === 0) {
            throw new ValidationError("'email' must be a non-empty string");
          }
          email = body.email;
        } catch (err) {
          // Every accepted request counts; one that never got past the body read or validation does not.
          reservation.release();
          throw err;
        }

        // Always 200 with the same body regardless of whether `email` matched an account —
        // issue #142's "request responses do not disclose whether an email exists".
        await requestPasswordReset(pool, options.passwordResetMailer, {
          email,
          appBaseUrl: options.appBaseUrl,
        });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/password-reset/consume") {
        const ip = clientIpFromRequest(req, { trustProxy: options.trustProxy ?? false });
        const reservation = acquireOrRefuse(res, "passwordResetConsume", ip);
        if (!reservation) return;
        try {
          const body = (await readJsonBody(req, { maxBytes: MAX_BODY_BYTES })) as {
            token?: unknown;
            newPassword?: unknown;
          };
          const { token, newPassword } = body;
          if (typeof token !== "string" || token.length === 0) {
            throw new ValidationError("'token' must be a non-empty string");
          }
          if (typeof newPassword !== "string" || newPassword.length === 0) {
            throw new ValidationError("'newPassword' must be a non-empty string");
          }
          await withTransaction(pool, (client) => resetPassword(client, { token, newPassword }));
        } catch (err) {
          // Only a rejected token counts; validation and infrastructure errors do not.
          if (!(err instanceof PasswordResetTokenError)) reservation.release();
          throw err;
        }
        reservation.release();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/logout") {
        const identity = await authenticateRequest(pool, req);
        await withTransaction(pool, (client) => logout(client, identity.session.id));
        sendJson(res, 200, { ok: true }, { "Set-Cookie": CLEAR_SESSION_COOKIE });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/auth/sessions") {
        const identity = await authenticateRequest(pool, req);
        const sessions = await withTransaction(pool, (client) => listActiveSessionsForUser(client, identity.user.id));
        sendJson(res, 200, {
          sessions: sessions.map((session) => ({
            id: session.id,
            current: session.id === identity.session.id,
            platform: session.platform,
            deviceKind: session.deviceKind,
            deviceName: session.deviceName,
            osVersion: session.osVersion,
            appVersion: session.appVersion,
            createdAt: session.createdAt,
            lastSeenAt: session.lastSeenAt,
          })),
        });
        return;
      }

      // Issue #1650: matched before REVOKE_SESSION_PATH, whose `:id/revoke` shape it never collides with.
      if (req.method === "POST" && url.pathname === REVOKE_OTHER_SESSIONS_PATH) {
        const identity = await authenticateRequest(pool, req);
        const revokedCount = await withTransaction(pool, (client) =>
          revokeOtherUserSessions(client, identity.user.id, identity.session.id),
        );
        sendJson(res, 200, { revokedCount });
        return;
      }

      const revokeMatch = url.pathname.match(REVOKE_SESSION_PATH);
      if (req.method === "POST" && revokeMatch) {
        const identity = await authenticateRequest(pool, req);
        // Group 1 of REVOKE_SESSION_PATH is not optional, so a successful match always
        // captured it; a runtime check here would be unreachable code.
        const sessionId = assertUuid(revokeMatch[1]!, "id");
        const revoked = await withTransaction(pool, (client) => revokeUserSession(client, identity.user.id, sessionId));
        sendJson(res, 200, { revoked });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/auth/self-person") {
        const identity = await authenticateRequest(pool, req);
        const body: unknown = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
        if (typeof body !== "object" || body === null || Array.isArray(body) || !("personId" in body)) {
          throw new ValidationError("'personId' must be a UUID or null");
        }
        if (body.personId !== null && typeof body.personId !== "string") {
          throw new ValidationError("'personId' must be a UUID or null");
        }
        const personId = body.personId === null ? null : assertUuid(body.personId, "personId");
        await runInTenant(identity.tenantId, () =>
          withTransaction(pool, (client) =>
            setSelfPersonId(
              client,
              personId,
              { writerKind: "user", onBehalfOfUserId: identity.user.id },
              identity.user.id,
            ),
          ),
        );
        sendJson(res, 200, { personId });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/auth/session") {
        const identity = await authenticateRequest(pool, req);
        const personId = await runInTenant(identity.tenantId, () => withTransaction(pool, getSelfPersonId));
        sendJson(res, 200, {
          user: { ...identity.user, role: identity.role, personId },
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
        sendJson(res, err.status, toPublicErrorBody(err));
        return;
      }
      logger.error({ err, method: req.method, path: url.pathname }, "Unexpected error handling request");
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
    // Authentication starts as system work; person reads/writes enter the verified tenant scope.
    runAsSystem("auth", () => handleRequest(req, res)).catch((err: unknown) => {
      logger.error({ err }, "Unhandled error in the request listener");
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "Internal server error" });
    });
  };
}
