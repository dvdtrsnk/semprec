import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createUser, hashPassword, type UserRow } from "@semprec/data";
import { createAuthRequestListener, SESSION_COOKIE_NAME } from "../authHandler.js";

let pool: Pool;

const PASSWORD = "s3cret-password";

async function makeUser(email = "person@example.com"): Promise<UserRow> {
  return createUser(pool, { email, passwordHash: await hashPassword(PASSWORD) });
}

function sessionCookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a Set-Cookie header");
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]*)`));
  if (!match) throw new Error(`expected a ${SESSION_COOKIE_NAME} cookie`);
  return match[1];
}

describe("createAuthRequestListener", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);

    server = createServer(createAuthRequestListener(pool));
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
    it("returns a token and sets a session cookie for correct credentials", async () => {
      const user = await makeUser();

      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "web" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; user: { id: string; email: string } };
      expect(body.token).toBeTruthy();
      expect(body.user.email).toBe(user.email);
      expect(body).not.toHaveProperty("user.passwordHash");
      expect(sessionCookieFrom(res)).toBe(encodeURIComponent(body.token));
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
  });

  describe("POST /api/auth/logout", () => {
    it("revokes only the session used to authenticate the logout call", async () => {
      const user = await makeUser();
      const first = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "web" }),
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
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "web" }),
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
        body: JSON.stringify({ email: owner.email, password: PASSWORD, platform: "web" }),
      });
      const { token: ownerToken } = (await ownerLogin.json()) as { token: string };
      const ownerSession = (await (
        await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${ownerToken}` } })
      ).json()) as { session: { id: string } };

      const attackerLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: attacker.email, password: PASSWORD, platform: "web" }),
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
  });
});
