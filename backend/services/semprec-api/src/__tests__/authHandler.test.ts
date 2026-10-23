import { createServer, request as httpRequest, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import pg, { type Pool } from "pg";
import { getTestPool, resetDatabase, tenantForNextTestUser } from "@semprec/data/testSupport";
import { createUser, hashPassword, LOCKOUT_THRESHOLD, type PasswordResetMailer, type UserRow } from "@semprec/data";
import { createAuthRequestListener, SESSION_COOKIE_NAME } from "../authHandler.js";
import { createClientIpThrottle } from "../clientIpThrottle.js";

let pool: Pool;

const PASSWORD = "s3cret-password";
const APP_BASE_URL = "https://app.example.test";

async function makeUser(email = "person@example.com"): Promise<UserRow> {
  return createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email,
    passwordHash: await hashPassword(PASSWORD),
  });
}

function sessionCookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a Set-Cookie header");
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]*)`));
  if (!match) throw new Error(`expected a ${SESSION_COOKIE_NAME} cookie`);
  return match[1]!;
}

interface FakeMailer extends PasswordResetMailer {
  sent: Array<{ to: string; resetUrl: string }>;
}

function createFakeMailer(): FakeMailer {
  const sent: Array<{ to: string; resetUrl: string }> = [];
  return {
    sent,
    async sendPasswordResetEmail(input) {
      sent.push(input);
    },
  };
}

function tokenFromResetUrl(resetUrl: string): string {
  const token = new URLSearchParams(new URL(resetUrl).hash.slice(1)).get("token");
  if (!token) throw new Error(`expected a token in the URL fragment of ${resetUrl}`);
  return token;
}

describe("createAuthRequestListener", () => {
  let server: Server;
  let baseUrl: string;
  let mailer: FakeMailer;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    mailer = createFakeMailer();

    server = createServer(
      createAuthRequestListener(pool, { passwordResetMailer: mailer, appBaseUrl: APP_BASE_URL, trustProxy: true }),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("POST /api/auth/login", () => {
    it("sets a session cookie for correct web credentials, and never puts the token in the body", async () => {
      const user = await makeUser();

      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "web" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { id: string; email: string }; token?: unknown };
      expect(body.token).toBeUndefined();
      expect(body.user.email).toBe(user.email);
      expect(body).not.toHaveProperty("user.passwordHash");
      expect(sessionCookieFrom(res)).toBeTruthy();
    });

    it("returns the token in the body and sets no cookie for native (ios/macos) credentials", async () => {
      const user = await makeUser();

      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; user: { id: string; email: string } };
      expect(body.token).toBeTruthy();
      expect(body.user.email).toBe(user.email);
      expect(res.headers.get("set-cookie")).toBeNull();
    });

    it("returns 401 for a wrong password", async () => {
      const user = await makeUser();
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: "wrong", platform: "web" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns the same 401 body shape for an unknown email as for a wrong password", async () => {
      const user = await makeUser();
      const wrongPassword = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: "wrong", platform: "web" }),
      });
      const unknownEmail = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.com", password: "wrong", platform: "web" }),
      });

      expect(wrongPassword.status).toBe(unknownEmail.status);
      expect(await wrongPassword.json()).toEqual(await unknownEmail.json());
    });

    function postLogin(email: string, password: string): Promise<Response> {
      return fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, platform: "web" }),
      });
    }

    it("locks out the correct password after LOCKOUT_THRESHOLD failures, recording every failed attempt", async () => {
      const user = await makeUser();

      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        const res = await postLogin(user.email, "wrong");
        expect(res.status).toBe(401);
      }
      const locked = await postLogin(user.email, PASSWORD);

      expect(locked.status).toBe(401);
      const failures = await pool.query<{ count: string }>(
        "SELECT count(*) FROM login_attempts WHERE succeeded = false",
      );
      expect(Number(failures.rows[0]!.count)).toBe(LOCKOUT_THRESHOLD + 1);
      const sessions = await pool.query<{ count: string }>("SELECT count(*) FROM sessions");
      expect(Number(sessions.rows[0]!.count)).toBe(0);
    });

    it("accepts the correct password below LOCKOUT_THRESHOLD and records the success with its session", async () => {
      const user = await makeUser();

      for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
        const res = await postLogin(user.email, "wrong");
        expect(res.status).toBe(401);
      }
      const ok = await postLogin(user.email, PASSWORD);

      expect(ok.status).toBe(200);
      const attempts = await pool.query<{ succeeded: boolean; count: string }>(
        "SELECT succeeded, count(*) FROM login_attempts GROUP BY succeeded ORDER BY succeeded",
      );
      expect(attempts.rows.map((row) => ({ succeeded: row.succeeded, count: Number(row.count) }))).toEqual([
        { succeeded: false, count: LOCKOUT_THRESHOLD - 1 },
        { succeeded: true, count: 1 },
      ]);
      const sessions = await pool.query<{ user_id: string }>("SELECT user_id FROM sessions");
      expect(sessions.rows).toEqual([{ user_id: user.id }]);
    });

    it("scopes the lockout to the forwarded client address, so another address can still log in", async () => {
      const user = await makeUser();
      const postLoginFrom = (forwardedFor: string, password: string): Promise<Response> =>
        fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Forwarded-For": forwardedFor },
          body: JSON.stringify({ email: user.email, password, platform: "web" }),
        });

      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        const res = await postLoginFrom("203.0.113.9", "wrong");
        expect(res.status).toBe(401);
      }
      const otherAddress = await postLoginFrom("198.51.100.4", PASSWORD);
      const attackerAddress = await postLoginFrom("203.0.113.9", PASSWORD);

      expect(otherAddress.status).toBe(200);
      expect(attackerAddress.status).toBe(401);
    });

    it("rejects an invalid platform", async () => {
      const user = await makeUser();
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "android" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/auth/session", () => {
    it("authenticates with the bearer token returned by login", async () => {
      const user = await makeUser();
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
      });
      const { token } = (await loginRes.json()) as { token: string };

      const res = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { user: { email: string } };
      expect(body.user.email).toBe(user.email);
    });

    it("returns the user's role", async () => {
      const user = await createUser(pool, {
        tenantId: await tenantForNextTestUser(pool),
        email: "admin@example.com",
        passwordHash: await hashPassword(PASSWORD),
        role: "admin",
      });
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
      });
      const { token } = (await loginRes.json()) as { token: string };

      const res = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } });
      const body = (await res.json()) as { user: { role: string } };
      expect(body.user.role).toBe("admin");
    });

    it("authenticates with the session cookie set by login", async () => {
      const user = await makeUser();
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "web" }),
      });
      const cookie = sessionCookieFrom(loginRes);

      const res = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      });
      expect(res.status).toBe(200);
    });

    it("returns 401 with no credentials", async () => {
      const res = await fetch(`${baseUrl}/api/auth/session`);
      expect(res.status).toBe(401);
    });

    it("returns 401 for a garbage bearer token", async () => {
      const res = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: "Bearer garbage" } });
      expect(res.status).toBe(401);
    });

    it("rejects a web session's token when presented as a bearer token", async () => {
      const user = await makeUser();
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "web" }),
      });
      const cookie = sessionCookieFrom(loginRes);

      const res = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Authorization: `Bearer ${decodeURIComponent(cookie)}` },
      });
      expect(res.status).toBe(401);
    });

    it("rejects a native session's token when presented as a cookie", async () => {
      const user = await makeUser();
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
      });
      const { token } = (await loginRes.json()) as { token: string };

      const res = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
      });
      expect(res.status).toBe(401);
    });

    it("rejects a macos native session's token when presented as a cookie", async () => {
      const user = await makeUser();
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "macos" }),
      });
      const { token } = (await loginRes.json()) as { token: string };

      const res = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("revokes only the session used to authenticate the logout call", async () => {
      const user = await makeUser();
      const first = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "macos" }),
      });
      const { token: tokenA } = (await first.json()) as { token: string };
      const second = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
      });
      const { token: tokenB } = (await second.json()) as { token: string };

      const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      expect(logoutRes.status).toBe(200);

      const afterLogoutA = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      expect(afterLogoutA.status).toBe(401);
      const afterLogoutB = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      expect(afterLogoutB.status).toBe(200);
    });

    it("returns 401 with no credentials", async () => {
      const res = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST" });
      expect(res.status).toBe(401);
    });
  });

  describe("POST /api/auth/sessions/:id/revoke", () => {
    it("lets an authenticated user revoke one of their other sessions", async () => {
      const user = await makeUser();
      const active = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
      });
      const { token: activeToken } = (await active.json()) as { token: string };
      const target = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "macos" }),
      });
      const { token: targetToken } = (await target.json()) as { token: string };
      const targetSession = (await (
        await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${targetToken}` } })
      ).json()) as { session: { id: string } };

      const revokeRes = await fetch(`${baseUrl}/api/auth/sessions/${targetSession.session.id}/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      expect(revokeRes.status).toBe(200);
      expect(await revokeRes.json()).toEqual({ revoked: true });

      const afterRevoke = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Authorization: `Bearer ${targetToken}` },
      });
      expect(afterRevoke.status).toBe(401);
      const stillActive = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Authorization: `Bearer ${activeToken}` },
      });
      expect(stillActive.status).toBe(200);
    });

    it("refuses to revoke another user's session", async () => {
      const owner = await makeUser("owner@example.com");
      const attacker = await makeUser("attacker@example.com");
      const ownerLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: owner.email, password: PASSWORD, platform: "ios" }),
      });
      const { token: ownerToken } = (await ownerLogin.json()) as { token: string };
      const ownerSession = (await (
        await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${ownerToken}` } })
      ).json()) as { session: { id: string } };

      const attackerLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: attacker.email, password: PASSWORD, platform: "ios" }),
      });
      const { token: attackerToken } = (await attackerLogin.json()) as { token: string };

      const revokeRes = await fetch(`${baseUrl}/api/auth/sessions/${ownerSession.session.id}/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${attackerToken}` },
      });
      expect(revokeRes.status).toBe(200);
      expect(await revokeRes.json()).toEqual({ revoked: false });

      const stillActive = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      expect(stillActive.status).toBe(200);
    });

    it("returns 400 validation_failed naming 'id' for a non-UUID session id", async () => {
      const user = await makeUser();
      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
      });
      const { token } = (await login.json()) as { token: string };

      const revokeRes = await fetch(`${baseUrl}/api/auth/sessions/foo/revoke`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(revokeRes.status).toBe(400);
      const body = (await revokeRes.json()) as { code: string; details?: unknown };
      expect(body.code).toBe("validation_failed");
      expect(body.details).toEqual({ field: "id" });
    });
  });

  describe("POST /api/auth/password-reset/request", () => {
    it("emails a signed reset link for a known email and returns ok", async () => {
      const user = await makeUser();

      const res = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.to).toBe(user.email);
      expect(mailer.sent[0]!.resetUrl.startsWith(`${APP_BASE_URL}/?page=password-reset#token=`)).toBe(true);
      expect(new URL(mailer.sent[0]!.resetUrl).searchParams.has("token")).toBe(false);
    });

    it("returns the identical response for an unknown email, without sending mail", async () => {
      const user = await makeUser();
      const known = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email }),
      });
      const unknown = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.com" }),
      });

      expect(unknown.status).toBe(known.status);
      expect(await unknown.json()).toEqual(await known.json());
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.to).toBe(user.email);
    });

    it("rejects a missing email", async () => {
      const res = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("answers a known email before the mail send has resolved", async () => {
      const user = await makeUser();
      const sent: Array<{ to: string; resetUrl: string }> = [];
      let release!: () => void;
      const pendingSend = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deferredMailer: PasswordResetMailer = {
        sendPasswordResetEmail(input) {
          sent.push(input);
          return pendingSend;
        },
      };
      const deferredServer = createServer(
        createAuthRequestListener(pool, {
          passwordResetMailer: deferredMailer,
          appBaseUrl: APP_BASE_URL,
          trustProxy: true,
        }),
      );
      await new Promise<void>((resolve) => deferredServer.listen(0, resolve));

      try {
        const address = deferredServer.address();
        if (!address || typeof address === "string") throw new Error("expected a bound TCP address");

        const res = await fetch(`http://127.0.0.1:${address.port}/api/auth/password-reset/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: user.email }),
        });

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(sent).toHaveLength(1);
        expect(sent[0]!.to).toBe(user.email);
      } finally {
        release();
        await new Promise<void>((resolve) => deferredServer.close(() => resolve()));
      }
    });
  });

  describe("POST /api/auth/password-reset/consume", () => {
    async function requestReset(email: string): Promise<string> {
      await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      return tokenFromResetUrl(mailer.sent.at(-1)!.resetUrl);
    }

    it("changes the password and lets the user log in with the new one", async () => {
      const user = await makeUser();
      const token = await requestReset(user.email);

      const res = await fetch(`${baseUrl}/api/auth/password-reset/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: "a-brand-new-password" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const oldPasswordLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "web" }),
      });
      expect(oldPasswordLogin.status).toBe(401);

      const newPasswordLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: "a-brand-new-password", platform: "web" }),
      });
      expect(newPasswordLogin.status).toBe(200);
    });

    it("rejects reusing an already-consumed token with a deterministic 'consumed' response", async () => {
      const user = await makeUser();
      const token = await requestReset(user.email);

      const first = await fetch(`${baseUrl}/api/auth/password-reset/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: "first-new-password" }),
      });
      expect(first.status).toBe(200);

      const second = await fetch(`${baseUrl}/api/auth/password-reset/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: "second-new-password" }),
      });
      expect(second.status).toBe(400);
      const body = (await second.json()) as { code: string };
      expect(body.code).toBe("password_reset_token_consumed");
    });

    it("rejects an unknown token with a deterministic 'invalid' response", async () => {
      const res = await fetch(`${baseUrl}/api/auth/password-reset/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "not-a-real-token", newPassword: "whatever-password" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("password_reset_token_invalid");
    });

    it("rejects a newPassword below the minimum length without consuming the token", async () => {
      const user = await makeUser();
      const token = await requestReset(user.email);

      const rejected = await fetch(`${baseUrl}/api/auth/password-reset/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: "short" }),
      });
      expect(rejected.status).toBe(400);
      const body = (await rejected.json()) as { code: string };
      expect(body.code).toBe("validation_failed");

      const retried = await fetch(`${baseUrl}/api/auth/password-reset/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: "a-brand-new-password" }),
      });
      expect(retried.status).toBe(200);
    });

    it("rejects a missing newPassword", async () => {
      const user = await makeUser();
      const token = await requestReset(user.email);

      const res = await fetch(`${baseUrl}/api/auth/password-reset/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("per-address throttle (issue #1073)", () => {
    let throttledServer: Server;
    let throttledUrl: string;
    let onThrottledArrival: () => void;
    const ADDRESS = "203.0.113.9";
    const OTHER_ADDRESS = "198.51.100.4";

    beforeEach(async () => {
      onThrottledArrival = () => {};
      const listener = createAuthRequestListener(pool, {
        passwordResetMailer: mailer,
        appBaseUrl: APP_BASE_URL,
        trustProxy: true,
        clientIpThrottle: createClientIpThrottle({
          limits: {
            login: { maxEvents: 3, windowSeconds: 900 },
            passwordResetRequest: { maxEvents: 2, windowSeconds: 3600 },
            passwordResetConsume: { maxEvents: 2, windowSeconds: 3600 },
          },
        }),
      });
      throttledServer = createServer((req, res) => {
        onThrottledArrival();
        listener(req, res);
      });
      await new Promise<void>((resolve) => throttledServer.listen(0, resolve));
      const address = throttledServer.address();
      if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
      throttledUrl = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => throttledServer.close(() => resolve()));
    });

    function post(path: string, from: string, body: unknown): Promise<Response> {
      return fetch(`${throttledUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": from },
        body: JSON.stringify(body),
      });
    }

    async function postBurstWithHeldBodies(path: string, bodies: unknown[]): Promise<number[]> {
      let arrived = 0;
      let allArrived!: () => void;
      const allArrivedPromise = new Promise<void>((resolve) => (allArrived = resolve));
      onThrottledArrival = () => {
        if (++arrived === bodies.length) allArrived();
      };
      const requests = bodies.map((body) => {
        const payload = JSON.stringify(body);
        const req = httpRequest(`${throttledUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(payload)),
            "X-Forwarded-For": ADDRESS,
          },
        });
        const status = new Promise<number>((resolve, reject) => {
          req.on("response", (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
            res.on("error", reject);
          });
          req.on("error", reject);
          req.setTimeout(5000, () => req.destroy(new Error("burst request timed out")));
        });
        return { req, payload, status };
      });
      const statuses = Promise.all(requests.map(({ status }) => status));
      const arrivalTimeout = setTimeout(() => {
        for (const { req } of requests) req.destroy(new Error("burst arrival barrier timed out"));
      }, 5000);
      try {
        for (const { req } of requests) req.flushHeaders();
        // The last arrival's listener runs synchronously through the throttle check before this
        // continuation sends any body. Every request therefore reaches that check before any body is read.
        await Promise.race([allArrivedPromise, statuses]);
        for (const { req, payload } of requests) req.end(payload);
        return await statuses;
      } finally {
        clearTimeout(arrivalTimeout);
        onThrottledArrival = () => {};
        for (const { req } of requests) req.destroy();
        await Promise.allSettled(requests.map(({ status }) => status));
      }
    }

    async function expectRateLimited(res: Response): Promise<void> {
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "Too many attempts; try again later", code: "rate_limited" });
      const retryAfter = res.headers.get("retry-after");
      expect(retryAfter).toMatch(/^[1-9][0-9]*$/);
    }

    it("refuses login from an address after its failed logins across different emails, even with correct credentials", async () => {
      const user = await makeUser();
      const login = (from: string, email: string, password: string): Promise<Response> =>
        post("/api/auth/login", from, { email, password, platform: "web" });

      // Neither a success nor a validation failure counts toward the limit.
      expect((await login(ADDRESS, user.email, PASSWORD)).status).toBe(200);
      expect((await post("/api/auth/login", ADDRESS, { email: user.email, platform: "web" })).status).toBe(400);
      for (let i = 0; i < 3; i++) {
        expect((await login(ADDRESS, `stuffing-${i}@example.com`, "wrong")).status).toBe(401);
      }

      await expectRateLimited(await login(ADDRESS, user.email, PASSWORD));
      const sessions = await pool.query<{ count: string }>("SELECT count(*) FROM sessions");
      expect(Number(sessions.rows[0]!.count)).toBe(1);

      expect((await login(OTHER_ADDRESS, user.email, PASSWORD)).status).toBe(200);
    });

    it("lets at most the login limit of a concurrent burst of failed logins from one address reach the credential check", async () => {
      const statuses = await postBurstWithHeldBodies(
        "/api/auth/login",
        Array.from({ length: 8 }, (_, i) => ({
          email: `burst-${i}@example.com`,
          password: "wrong",
          platform: "web",
        })),
      );

      expect(statuses.filter((status) => status === 401)).toHaveLength(3);
      expect(statuses.filter((status) => status === 429)).toHaveLength(5);
      const attempts = await pool.query<{ count: string }>("SELECT count(*) FROM login_attempts");
      expect(Number(attempts.rows[0]!.count)).toBe(3);
    });

    it("answers a throttled login with 429 before reading an oversized body", async () => {
      for (let i = 0; i < 3; i++) {
        const failed = await post("/api/auth/login", ADDRESS, {
          email: `stuffing-${i}@example.com`,
          password: "wrong",
          platform: "web",
        });
        expect(failed.status).toBe(401);
      }

      await expectRateLimited(
        await post("/api/auth/login", ADDRESS, {
          email: "x@example.com",
          password: "p".repeat(128 * 1024),
          platform: "web",
        }),
      );
      const oversizedElsewhere = await post("/api/auth/login", OTHER_ADDRESS, {
        email: "x@example.com",
        password: "p".repeat(128 * 1024),
        platform: "web",
      });
      expect(oversizedElsewhere.status).toBe(413);
    });

    it("does not count a login that failed for a reason other than its credentials", async () => {
      // A pool whose connections are refused makes `login` throw an infrastructure error, not UnauthorizedError.
      const unreachablePool = new pg.Pool({ host: "127.0.0.1", port: 1, connectionTimeoutMillis: 1000 });
      const throttle = createClientIpThrottle({ limits: { login: { maxEvents: 1, windowSeconds: 900 } } });
      const brokenServer = createServer(
        createAuthRequestListener(unreachablePool, {
          passwordResetMailer: mailer,
          appBaseUrl: APP_BASE_URL,
          trustProxy: true,
          clientIpThrottle: throttle,
        }),
      );
      try {
        await new Promise<void>((resolve) => brokenServer.listen(0, resolve));
        const address = brokenServer.address();
        if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
        for (let i = 0; i < 3; i++) {
          const res = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Forwarded-For": ADDRESS },
            body: JSON.stringify({ email: "person@example.com", password: "wrong", platform: "web" }),
          });
          expect(res.status).toBe(500);
        }
        expect(throttle.retryAfterSeconds("login", ADDRESS)).toBeNull();
      } finally {
        await new Promise<void>((resolve) => brokenServer.close(() => resolve()));
        await unreachablePool.end();
      }
    });

    it("lets at most the reset-request limit of a concurrent burst from one address through, even with slow bodies", async () => {
      const user = await makeUser();
      const statuses = await postBurstWithHeldBodies(
        "/api/auth/password-reset/request",
        Array.from({ length: 5 }, () => ({ email: user.email })),
      );

      expect(statuses.filter((status) => status === 200)).toHaveLength(2);
      expect(statuses.filter((status) => status === 429)).toHaveLength(3);
      const tokens = await pool.query<{ count: string }>("SELECT count(*) FROM password_reset_tokens");
      expect(Number(tokens.rows[0]!.count)).toBe(2);
    });

    it("refuses a password-reset request past the limit without creating a token, and answers alike below it", async () => {
      const user = await makeUser();
      const requestReset = (email: unknown): Promise<Response> =>
        post("/api/auth/password-reset/request", ADDRESS, { email });

      // A validation failure does not count.
      expect((await requestReset(undefined)).status).toBe(400);
      const known = await requestReset(user.email);
      const unknown = await requestReset("nobody@example.com");
      expect(known.status).toBe(200);
      expect(await known.json()).toEqual({ ok: true });
      expect(unknown.status).toBe(200);
      expect(await unknown.json()).toEqual({ ok: true });

      await expectRateLimited(await requestReset(user.email));
      const tokens = await pool.query<{ count: string }>("SELECT count(*) FROM password_reset_tokens");
      expect(Number(tokens.rows[0]!.count)).toBe(1);

      const otherAddress = await post("/api/auth/password-reset/request", OTHER_ADDRESS, { email: user.email });
      expect(otherAddress.status).toBe(200);
    });

    it("lets at most the consume limit of a concurrent burst of token guesses from one address reach the token check", async () => {
      const statuses = await postBurstWithHeldBodies(
        "/api/auth/password-reset/consume",
        Array.from({ length: 6 }, (_, i) => ({
          token: `not-a-token-${i}`,
          newPassword: "a-brand-new-password",
        })),
      );

      expect(statuses.filter((status) => status === 400)).toHaveLength(2);
      expect(statuses.filter((status) => status === 429)).toHaveLength(4);
    });

    it("refuses consuming from an address after its invalid-token attempts, without consuming a valid token", async () => {
      const user = await makeUser();
      await post("/api/auth/password-reset/request", OTHER_ADDRESS, { email: user.email });
      const token = tokenFromResetUrl(mailer.sent.at(-1)!.resetUrl);
      const consume = (from: string, body: unknown): Promise<Response> =>
        post("/api/auth/password-reset/consume", from, body);

      // A validation failure (password too short) does not count.
      expect((await consume(ADDRESS, { token, newPassword: "short" })).status).toBe(400);
      for (let i = 0; i < 2; i++) {
        const invalid = await consume(ADDRESS, { token: `not-a-token-${i}`, newPassword: "a-brand-new-password" });
        expect(invalid.status).toBe(400);
      }

      await expectRateLimited(await consume(ADDRESS, { token, newPassword: "a-brand-new-password" }));
      const pending = await pool.query<{ consumed_at: Date | null }>(
        "SELECT consumed_at FROM password_reset_tokens WHERE user_id = $1",
        [user.id],
      );
      expect(pending.rows).toEqual([{ consumed_at: null }]);

      expect((await consume(OTHER_ADDRESS, { token, newPassword: "a-brand-new-password" })).status).toBe(200);
    });
  });
});
