import { randomUUID } from "node:crypto";
import { runInTenant, runAsSystem } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant } from "@semprec/data/testSupport";
import {
  seedSystem,
  createChokePoint,
  getDatabaseByModuleId,
  withTransaction,
  insertValueLink,
  setInvalidationHook,
  type InvalidationEvent,
} from "@semprec/data";
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg, { type Pool } from "pg";
import { getTestPool, resetDatabase, tenantForNextTestUser } from "@semprec/data/testSupport";
import {
  createUser,
  hashPassword,
  isSessionActive,
  listPushSubscriptionsForUser,
  LOCKOUT_THRESHOLD,
  setAgentRunEventHook,
  setDocUpdateHook,
  setNotificationCreatedHook,
  setNotificationReadStateHook,
  setSempThreadInvalidationHook,
  setSessionRevokedHook,
  suspendAccount,
  upsertApnsSubscription,
  upsertWebPushSubscription,
  type PasswordResetMailer,
  type UserRow,
} from "@semprec/data";
import { WebSocket } from "ws";
import { z } from "zod";
import { wireRealtimeHooks, type SyncServer } from "@semprec/realtime";
import { createSyncUpgradeHandler } from "../syncHandler.js";
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
      const body: unknown = await res.json();
      expect(body).not.toHaveProperty("token");
      expect(body).toMatchObject({ user: { email: user.email } });
      expect(body).not.toHaveProperty("user.passwordHash");
      expect(sessionCookieFrom(res)).toBeTruthy();
      expect(res.headers.get("set-cookie")).toContain(`Max-Age=${365 * 24 * 60 * 60}`);
    });

    it("returns the token in the body and sets no cookie for native (ios/macos) credentials", async () => {
      const user = await makeUser();

      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
      });

      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ token: expect.stringMatching(/.+/), user: { email: user.email } });
      expect(res.headers.get("set-cookie")).toBeNull();
    });

    it("returns a null displayName and the role in the web login body", async () => {
      const user = await makeUser();

      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "web" }),
      });

      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ user: { displayName: null, role: "member" } });
    });

    it("returns a null displayName and the role in the native login body", async () => {
      const user = await makeUser();

      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
      });

      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ user: { displayName: null, role: "member" } });
    });

    it("returns the stored displayName and an admin's role in the native login body", async () => {
      const user = await createUser(pool, {
        tenantId: await tenantForNextTestUser(pool),
        email: "admin@example.com",
        passwordHash: await hashPassword(PASSWORD),
        role: "admin",
      });
      // Set the stored value directly to exercise the read path required by issue #1387.
      await pool.query("UPDATE users SET display_name = $2 WHERE id = $1", [user.id, "Ada Lovelace"]);

      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
      });

      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ user: { displayName: "Ada Lovelace", role: "admin" } });
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

    describe("device identity", () => {
      const DEVICE_ID = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
      const SAFARI_MAC_UA =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

      interface DeviceRow {
        device_id: string | null;
        device_name: string | null;
        device_kind: string | null;
        os_version: string | null;
        app_version: string | null;
      }

      async function postDeviceLogin(extra: Record<string, unknown>, userAgent?: string): Promise<Response> {
        const user = await makeUser();
        return fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(userAgent ? { "User-Agent": userAgent } : {}) },
          body: JSON.stringify({ email: user.email, password: PASSWORD, ...extra }),
        });
      }

      async function deviceRows(): Promise<DeviceRow[]> {
        const { rows } = await pool.query<DeviceRow>(
          "SELECT device_id, device_name, device_kind, os_version, app_version FROM sessions",
        );
        return rows;
      }

      it("stores the device fields of a native login", async () => {
        const res = await postDeviceLogin({
          platform: "ios",
          deviceId: DEVICE_ID,
          deviceName: " iPhone 17 Pro ",
          deviceKind: "iphone",
          osVersion: "26.0",
          appVersion: "1.2.3",
        });
        expect(res.status).toBe(200);
        expect(await deviceRows()).toEqual([
          {
            device_id: DEVICE_ID,
            device_name: "iPhone 17 Pro",
            device_kind: "iphone",
            os_version: "26.0",
            app_version: "1.2.3",
          },
        ]);
      });

      it("accepts a macos login with deviceKind mac", async () => {
        const res = await postDeviceLogin({ platform: "macos", deviceKind: "mac" });
        expect(res.status).toBe(200);
        expect((await deviceRows())[0]!.device_kind).toBe("mac");
      });

      it("leaves the device columns NULL when a native login sends none", async () => {
        const res = await postDeviceLogin({ platform: "ios" });
        expect(res.status).toBe(200);
        expect(await deviceRows()).toEqual([
          { device_id: null, device_name: null, device_kind: null, os_version: null, app_version: null },
        ]);
      });

      it.each([
        ["an unknown deviceKind", { platform: "ios", deviceKind: "phone" }, "deviceKind"],
        ["a mac deviceKind on ios", { platform: "ios", deviceKind: "mac" }, "deviceKind"],
        ["an iphone deviceKind on macos", { platform: "macos", deviceKind: "iphone" }, "deviceKind"],
        ["a non-UUID deviceId", { platform: "ios", deviceId: "not-a-uuid" }, "deviceId"],
        ["a non-string deviceId", { platform: "ios", deviceId: 7 }, "deviceId"],
        ["a null deviceId", { platform: "ios", deviceId: null }, "deviceId"],
        ["a null deviceKind", { platform: "ios", deviceKind: null }, "deviceKind"],
        ["a null deviceName", { platform: "ios", deviceName: null }, "deviceName"],
        ["a null osVersion", { platform: "ios", osVersion: null }, "osVersion"],
        ["a null appVersion", { platform: "ios", appVersion: null }, "appVersion"],
        ["an empty deviceName", { platform: "ios", deviceName: "   " }, "deviceName"],
        ["a 101-character deviceName", { platform: "ios", deviceName: "a".repeat(101) }, "deviceName"],
        ["a non-string osVersion", { platform: "macos", osVersion: 26 }, "osVersion"],
        ["a 51-character osVersion", { platform: "ios", osVersion: "1".repeat(51) }, "osVersion"],
        ["a 51-character appVersion", { platform: "ios", appVersion: "1".repeat(51) }, "appVersion"],
      ])("rejects %s with 400 naming the field and creates no session", async (_label, body, field) => {
        const res = await postDeviceLogin(body);
        expect(res.status).toBe(400);
        const json = (await res.json()) as { code: string; details?: { field?: string } };
        expect(json.code).toBe("validation_failed");
        expect(json.details?.field).toBe(field);
        expect(await deviceRows()).toEqual([]);
      });

      it("accepts a deviceName of exactly 100 characters", async () => {
        const res = await postDeviceLogin({ platform: "ios", deviceName: "a".repeat(100) });
        expect(res.status).toBe(200);
      });

      it("derives the device of a web login from the User-Agent and ignores body fields", async () => {
        const res = await postDeviceLogin(
          {
            platform: "web",
            deviceId: DEVICE_ID,
            deviceName: "iPhone 17 Pro",
            deviceKind: "iphone",
            osVersion: "26.0",
            appVersion: "9.9.9",
          },
          SAFARI_MAC_UA,
        );
        expect(res.status).toBe(200);
        expect(await deviceRows()).toEqual([
          { device_id: null, device_name: "Safari", device_kind: "browser", os_version: "macOS", app_version: null },
        ]);
      });

      it("does not reject a web login whose device fields are invalid", async () => {
        const res = await postDeviceLogin({ platform: "web", deviceKind: "phone", deviceId: "nope" }, SAFARI_MAC_UA);
        expect(res.status).toBe(200);
      });
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

  describe("GET /api/auth/sessions", () => {
    it("returns only active caller sessions with the exact public fields", async () => {
      const user = await makeUser();
      const other = await makeUser("other@example.com");
      const signIn = async (email: string) => {
        const response = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: PASSWORD, platform: "web" }),
        });
        expect(response.status).toBe(200);
        return sessionCookieFrom(response);
      };
      const cookies = [];
      for (let i = 0; i < 5; i++) cookies.push(await signIn(user.email));
      await signIn(other.email);
      const rows = await pool.query<{ id: string }>(
        "SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at, id",
        [user.id],
      );
      expect(rows.rows).toHaveLength(5);
      const ids = rows.rows.map((row) => row.id);
      // Older sessions predate device identity and cannot be created by the current login route.
      await pool.query(
        "UPDATE sessions SET device_id = NULL, device_kind = NULL, device_name = NULL, os_version = NULL, app_version = NULL WHERE id = $1",
        [ids[0]],
      );
      await pool.query("UPDATE sessions SET last_seen_at = now() - interval '1 hour' WHERE id = $1", [ids[1]]);
      await pool.query("UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE id = $1", [ids[2]]);
      await pool.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [ids[3]]);
      await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [ids[4]]);
      const response = await fetch(`${baseUrl}/api/auth/sessions`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookies[0]}` },
      });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toEqual({
        sessions: [
          expect.objectContaining({
            id: ids[0],
            current: true,
            platform: "web",
            deviceKind: null,
            deviceName: null,
            osVersion: null,
            appVersion: null,
          }),
          expect.objectContaining({ id: ids[1], current: false }),
          expect.objectContaining({ id: ids[2], current: false }),
        ],
      });
      if (typeof body !== "object" || body === null || !("sessions" in body) || !Array.isArray(body.sessions))
        throw new Error("Invalid sessions response");
      const sessions: unknown[] = body.sessions;
      for (const session of sessions) {
        if (typeof session !== "object" || session === null || Array.isArray(session))
          throw new Error("Invalid session");
        expect(Object.keys(session).sort()).toEqual([
          "appVersion",
          "createdAt",
          "current",
          "deviceKind",
          "deviceName",
          "id",
          "lastSeenAt",
          "osVersion",
          "platform",
        ]);
      }
      expect((await fetch(`${baseUrl}/api/auth/sessions`)).status).toBe(401);
    });
  });

  describe("GET /api/auth/session", () => {
    it.each([
      ["ios", 90],
      ["web", 30],
    ] as const)(
      "slides a %s session through authenticated HTTP without changing its response",
      async (platform, days) => {
        const user = await makeUser();
        const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: user.email, password: PASSWORD, platform }),
        });
        expect(loginResponse.status).toBe(200);
        let headers: Record<string, string>;
        if (platform === "web") {
          headers = { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookieFrom(loginResponse)}` };
        } else {
          const body: unknown = await loginResponse.json();
          if (typeof body !== "object" || body === null || !("token" in body) || typeof body.token !== "string") {
            throw new Error("Native login did not return a token");
          }
          headers = { Authorization: `Bearer ${body.token}` };
        }
        // Age the expiry to exercise the sliding update; the login API cannot backdate a session.
        await withTransaction(pool, (client) =>
          client.query("UPDATE sessions SET expires_at = now() + interval '1 day' WHERE user_id = $1", [user.id]),
        );
        const first = await fetch(`${baseUrl}/api/auth/session`, { headers });
        expect(first.status).toBe(200);
        const firstBody: unknown = await first.json();
        const expiry = await pool.query<{ expires_at: Date }>("SELECT expires_at FROM sessions WHERE user_id = $1", [
          user.id,
        ]);
        const firstExpiry = expiry.rows[0]?.expires_at.getTime();
        expect(firstExpiry).toBeDefined();
        expect(Math.abs((firstExpiry ?? 0) - Date.now() - days * 86400_000)).toBeLessThan(60_000);
        const second = await fetch(`${baseUrl}/api/auth/session`, { headers });
        expect(second.status).toBe(200);
        expect(await second.json()).toEqual(firstBody);
        const after = await pool.query<{ expires_at: Date }>("SELECT expires_at FROM sessions WHERE user_id = $1", [
          user.id,
        ]);
        expect(after.rows[0]?.expires_at.getTime()).toBeGreaterThanOrEqual(firstExpiry ?? 0);
      },
    );

    it("caps an old native session at its absolute lifetime through authenticated HTTP", async () => {
      const user = await makeUser();
      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
      });
      const body: unknown = await loginResponse.json();
      if (typeof body !== "object" || body === null || !("token" in body) || typeof body.token !== "string") {
        throw new Error("Native login did not return a token");
      }
      // Synthetic age: production login cannot create an already-aged session.
      await withTransaction(pool, (client) =>
        client.query(
          "UPDATE sessions SET created_at = now() - interval '364 days', expires_at = now() + interval '1 hour' WHERE user_id = $1",
          [user.id],
        ),
      );
      const response = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Authorization: `Bearer ${body.token}` },
      });
      expect(response.status).toBe(200);
      const result = await pool.query<{ capped: boolean }>(
        "SELECT expires_at = created_at + interval '365 days' AS capped FROM sessions WHERE user_id = $1",
        [user.id],
      );
      expect(result.rows).toEqual([{ capped: true }]);
    });

    it.each([
      [300, false],
      [340, true],
    ] as const)(
      "applies the web idle window and ceiling to an active %i-day-old session through HTTP",
      async (ageDays, capped) => {
        const user = await makeUser();
        const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "web" }),
        });
        expect(loginResponse.status).toBe(200);
        const cookie = sessionCookieFrom(loginResponse);
        // Synthetic age: the login API cannot backdate a still-active session.
        await withTransaction(pool, (client) =>
          client.query(
            "UPDATE sessions SET created_at = now() - make_interval(days => $2::int), expires_at = now() + interval '1 hour' WHERE user_id = $1",
            [user.id, ageDays],
          ),
        );
        const response = await fetch(`${baseUrl}/api/auth/session`, {
          headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
        });
        expect(response.status).toBe(200);
        const { rows } = await pool.query<{ capped: boolean; idle_seconds: number }>(
          "SELECT expires_at = created_at + interval '365 days' AS capped, extract(epoch FROM (expires_at - now()))::double precision AS idle_seconds FROM sessions WHERE user_id = $1",
          [user.id],
        );
        expect(rows[0]?.capped).toBe(capped);
        expect(Math.abs((rows[0]?.idle_seconds ?? 0) - (capped ? 25 : 30) * 86400)).toBeLessThan(60);
      },
    );

    it("rejects an expired web session over HTTP without renewing it", async () => {
      const user = await makeUser();
      const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "web" }),
      });
      const cookie = sessionCookieFrom(loginResponse);
      // A valid login cannot create an already-expired session.
      await withTransaction(pool, (client) =>
        client.query(
          "UPDATE sessions SET created_at = now() - interval '31 days', expires_at = now() - interval '1 day' WHERE user_id = $1",
          [user.id],
        ),
      );
      const response = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      });
      expect(response.status).toBe(401);
      const result = await pool.query<{ expired: boolean }>(
        "SELECT expires_at < now() AS expired FROM sessions WHERE user_id = $1",
        [user.id],
      );
      expect(result.rows).toEqual([{ expired: true }]);
    });

    it("authenticates with the bearer token returned by login", async () => {
      const user = await makeUser();
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
      });
      const loginBody: unknown = await loginRes.json();
      if (
        typeof loginBody !== "object" ||
        loginBody === null ||
        !("token" in loginBody) ||
        typeof loginBody.token !== "string"
      )
        throw new Error("expected token");
      const token = loginBody.token;

      const res = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ user: { email: user.email } });
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
      const loginBody: unknown = await loginRes.json();
      if (
        typeof loginBody !== "object" ||
        loginBody === null ||
        !("token" in loginBody) ||
        typeof loginBody.token !== "string"
      )
        throw new Error("expected token");
      const token = loginBody.token;

      const res = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } });
      const body: unknown = await res.json();
      expect(body).toMatchObject({ user: { role: "admin" } });
    });

    it("returns a null displayName for an account without one", async () => {
      const user = await makeUser();
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
      });
      const loginBody: unknown = await loginRes.json();
      if (
        typeof loginBody !== "object" ||
        loginBody === null ||
        !("token" in loginBody) ||
        typeof loginBody.token !== "string"
      )
        throw new Error("expected token");
      const token = loginBody.token;

      const res = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ user: { displayName: null } });
    });

    it("returns the stored displayName", async () => {
      const user = await makeUser();
      // Set the stored value directly to exercise the read path required by issue #1387.
      await pool.query("UPDATE users SET display_name = $2 WHERE id = $1", [user.id, "Ada Lovelace"]);
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
      });
      const loginBody: unknown = await loginRes.json();
      if (
        typeof loginBody !== "object" ||
        loginBody === null ||
        !("token" in loginBody) ||
        typeof loginBody.token !== "string"
      )
        throw new Error("expected token");
      const token = loginBody.token;

      const res = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ user: { displayName: "Ada Lovelace" } });
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

describe("self person HTTP contract", () => {
  let admin: Pool;
  let runtime: Pool;
  let server: Server;
  let baseUrl: string;
  let tenantId: string;
  let token: string;
  let actorId: string;
  let peopleId: string;
  let ownId: string;
  let foreignId: string;

  beforeEach(async () => {
    admin ??= getTestPool();
    runtime ??= await createRuntimeRolePool(admin, "semprec_data");
    const runtimeRole = await runAsSystem("test:verify-runtime-role", () =>
      runtime.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(runtimeRole.rows).toEqual([{ role_name: "semprec_data", rolsuper: false, rolbypassrls: false }]);
    await resetDatabase(admin);
    tenantId = await createTestTenant(admin);
    const other = await createTestTenant(admin);
    const passwordHash = await hashPassword(PASSWORD);
    const user = await runAsSystem("self person test user", () =>
      createUser(admin, {
        tenantId,
        email: "self@example.com",
        passwordHash,
      }),
    );
    actorId = user.id;
    for (const id of [tenantId, other]) {
      await runInTenant(id, async () => {
        await seedSystem(runtime);
        const people = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "people"));
        if (!people) throw new Error("People missing");
        const person = await createChokePoint(runtime).createItem({
          databaseId: people.id,
          properties: { name: "Person" },
        });
        if (id === tenantId) {
          peopleId = people.id;
          ownId = person.id;
        } else foreignId = person.id;
      });
    }
    server = createServer(
      createAuthRequestListener(runtime, { passwordResetMailer: createFakeMailer(), appBaseUrl: APP_BASE_URL }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TCP address missing");
    baseUrl = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "self@example.com", password: PASSWORD, platform: "ios" }),
    });
    expect(login.status).toBe(200);
    const body: unknown = await login.json();
    if (typeof body !== "object" || body === null || !("token" in body) || typeof body.token !== "string")
      throw new Error("Login token missing");
    token = body.token;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  async function put(body: unknown, authenticated = true) {
    return fetch(`${baseUrl}/api/auth/self-person`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }
  async function personId(): Promise<unknown> {
    const res = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("user" in body) ||
      typeof body.user !== "object" ||
      body.user === null ||
      !("personId" in body.user)
    )
      throw new Error("personId missing");
    return body.user.personId;
  }
  it("sets, replaces and clears the link, returning it through the session", async () => {
    expect(await personId()).toBeNull();
    const first = await put({ personId: ownId });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ personId: ownId });
    expect(await personId()).toBe(ownId);
    const next = await runInTenant(tenantId, () =>
      createChokePoint(runtime).createItem({ databaseId: peopleId, properties: { name: "Next" } }),
    );
    expect((await put({ personId: next.id })).status).toBe(200);
    expect(await personId()).toBe(next.id);
    expect((await put({ personId: null })).status).toBe(200);
    expect(await personId()).toBeNull();
  });
  it("attributes a linked self-person change to the authenticated user", async () => {
    const singletonId = await runInTenant(tenantId, async () => {
      const result = await runtime.query<{ id: string }>(
        `SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id
         WHERE d.owner_module_id = 'systemSettings' AND d.system = true AND i.deleted_at IS NULL`,
      );
      if (result.rows.length !== 1 || !result.rows[0]) throw new Error("Missing settings singleton");
      const id = result.rows[0].id;
      await withTransaction(runtime, (client) =>
        insertValueLink(client, {
          itemId: id,
          propertyKey: "selfPerson",
          ruleKey: "test",
          sources: [],
        }),
      );
      return id;
    });
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      expect((await put({ personId: ownId })).status).toBe(200);
      expect(events.filter((event) => event.scope === "item" && event.itemId === singletonId)).toEqual([
        expect.objectContaining({ userId: actorId }),
      ]);
    } finally {
      setInvalidationHook(() => {});
    }
  });
  it("attributes removal of an existing linked self-person edge to the authenticated user", async () => {
    expect((await put({ personId: ownId })).status).toBe(200);
    const singletonId = await runInTenant(tenantId, async () => {
      const result = await runtime.query<{ id: string }>(
        `SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id
         WHERE d.owner_module_id = 'systemSettings' AND d.system = true AND i.deleted_at IS NULL`,
      );
      if (result.rows.length !== 1 || !result.rows[0]) throw new Error("Missing settings singleton");
      const id = result.rows[0].id;
      await withTransaction(runtime, (client) =>
        insertValueLink(client, {
          itemId: id,
          propertyKey: "selfPerson",
          ruleKey: "test",
          sources: [],
        }),
      );
      return id;
    });
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      expect((await put({ personId: null })).status).toBe(200);
      expect(await personId()).toBeNull();
      const edges = await runInTenant(tenantId, () =>
        runtime.query<{ id: string }>(
          `SELECT edge.id FROM item_relations edge JOIN relation_definitions rd ON rd.id = edge.relation_definition_id
         JOIN properties p ON p.id = rd.property_id_a WHERE p.key = 'selfPerson' AND edge.item_a = $1 AND edge.item_b = $2`,
          [singletonId, ownId],
        ),
      );
      expect(edges.rows).toEqual([]);
      const links = await runInTenant(tenantId, () => createChokePoint(runtime).getValueLinksForItems([singletonId]));
      expect(links.get(singletonId)?.selfPerson).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
      expect(events.filter((event) => event.scope === "item" && event.itemId === singletonId)).toEqual([
        expect.objectContaining({ userId: actorId }),
      ]);
      events.length = 0;
      expect((await put({ personId: null })).status).toBe(200);
      expect(events).toEqual([]);
    } finally {
      setInvalidationHook(() => {});
    }
  });
  it("reads a trashed or purged person as unset and rejects linking a trashed person", async () => {
    expect((await put({ personId: ownId })).status).toBe(200);
    await runInTenant(tenantId, () => createChokePoint(runtime).softDeleteItem(peopleId, ownId));
    expect(await personId()).toBeNull();
    expect((await put({ personId: ownId })).status).toBe(404);
    const purged = await runInTenant(tenantId, () =>
      createChokePoint(runtime).purgeExpiredTrashSubtree(ownId, new Date(Date.now() + 60_000)),
    );
    expect(purged.purgedItemIds).toContain(ownId);
    expect(await personId()).toBeNull();
  });
  it("returns identical 404 bodies for foreign and unknown ids, preserving the previous link", async () => {
    expect((await put({ personId: ownId })).status).toBe(200);
    const foreign = await put({ personId: foreignId });
    const missing = await put({ personId: randomUUID() });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(await personId()).toBe(ownId);
  });
  it("serializes concurrent replacements so exactly one edge remains", async () => {
    const next = await runInTenant(tenantId, () =>
      createChokePoint(runtime).createItem({ databaseId: peopleId, properties: { name: "Next" } }),
    );
    const results = await Promise.all([put({ personId: ownId }), put({ personId: next.id })]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect([ownId, next.id]).toContain(await personId());
    const edges = await runInTenant(tenantId, () =>
      runtime.query<{ item_b: string }>(
        `SELECT edge.item_b FROM item_relations edge JOIN relation_definitions rd ON rd.id = edge.relation_definition_id
       JOIN properties p ON p.id = rd.property_id_a WHERE p.key = 'selfPerson'`,
      ),
    );
    expect(edges.rows).toHaveLength(1);
  });
  it("refuses a live item outside People with the same 404", async () => {
    const item = await runInTenant(tenantId, async () => {
      const db = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "events"));
      if (!db) throw new Error("Events missing");
      return createChokePoint(runtime).createItem({
        databaseId: db.id,
        properties: { name: "Event", date: "2026-10-22" },
      });
    });
    const invalid = await put({ personId: item.id });
    const missing = await put({ personId: randomUUID() });
    expect(invalid.status).toBe(404);
    expect(await invalid.json()).toEqual(await missing.json());
  });
  it("requires authentication and validates personId before writing", async () => {
    expect((await put({ personId: ownId }, false)).status).toBe(401);
    for (const body of [{}, null, [], { personId: 1 }, { personId: "bad" }]) expect((await put(body)).status).toBe(400);
    expect(await personId()).toBeNull();
  });
});

describe("POST /api/auth/sessions/revoke-others (issue #1650)", () => {
  let server: Server | undefined;
  let syncServer: SyncServer | undefined;
  let baseUrl: string;
  let wsBaseUrl: string;

  // The describes above end the file's pool in their afterAll; this one opens and ends its own.
  beforeAll(() => {
    pool = getTestPool();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    wireRealtimeHooks(pool);
    const sync = await createSyncUpgradeHandler(pool);
    syncServer = sync;
    const http = createServer(
      createAuthRequestListener(pool, { passwordResetMailer: createFakeMailer(), appBaseUrl: APP_BASE_URL }),
    );
    server = http;
    http.on("upgrade", (req, socket, head) => sync.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsBaseUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await syncServer?.close();
    const http = server;
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    syncServer = undefined;
    server = undefined;
  });

  afterAll(async () => {
    await pool?.end();
  });

  const loginBody = z.object({ token: z.string() });
  const sessionBody = z.object({ session: z.object({ id: z.string() }) });

  async function signIn(email: string): Promise<{ token: string; sessionId: string }> {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, platform: "ios" }),
    });
    const { token } = loginBody.parse(await res.json());
    const current = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } });
    return { token, sessionId: sessionBody.parse(await current.json()).session.id };
  }

  async function sessionStatus(token: string): Promise<number> {
    return (await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } })).status;
  }

  async function revokeOthers(token: string): Promise<Response> {
    return fetch(`${baseUrl}/api/auth/sessions/revoke-others`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async function registration(userId: string, sessionId: string): Promise<string> {
    const row = await upsertWebPushSubscription(pool, {
      userId,
      sessionId,
      endpoint: `https://push.example.test/${randomUUID()}`,
      p256dh: "key",
      authSecret: "secret",
    });
    return row.id;
  }

  async function revokedAt(id: string): Promise<Date | null> {
    const { rows } = await pool.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM push_subscriptions WHERE id = $1",
      [id],
    );
    const row = rows[0];
    if (!row) throw new Error("registration not found");
    return row.revoked_at;
  }

  interface OpenedSocket {
    socket: WebSocket;
    /** The close code, and the closed session's `revoked_at` read the moment the close arrived. */
    closed: Promise<{ code: number; sessionRevokedAt: Date | null }>;
  }

  async function sessionRevokedAt(sessionId: string): Promise<Date | null> {
    const { rows } = await pool.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM sessions WHERE id = $1", [
      sessionId,
    ]);
    const row = rows[0];
    if (!row) throw new Error("session not found");
    return row.revoked_at;
  }

  /**
   * Opens a sync socket for one session and records it in `opened` before waiting for it to open, so a case's
   * cleanup ends every socket it started, including one whose opening failed.
   */
  async function openSocket(
    session: { token: string; sessionId: string },
    opened: OpenedSocket[],
  ): Promise<OpenedSocket> {
    const socket = new WebSocket(`${wsBaseUrl}/api/sync`, { headers: { Authorization: `Bearer ${session.token}` } });
    const closed = new Promise<number>((resolve) => socket.once("close", (code: number) => resolve(code))).then(
      async (code) => ({ code, sessionRevokedAt: await sessionRevokedAt(session.sessionId) }),
    );
    // Read by the case, or by the cleanup; observed here too, so a failed read is never an unhandled rejection.
    closed.catch(() => undefined);
    const entry = { socket, closed };
    opened.push(entry);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return entry;
  }

  /** Rejects naming `what` when `work` has not settled within `ms`; the timer is cleared either way. */
  async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  it("keeps only the calling session: 200 with the count, 401 for the others, their pushes revoked and both other sockets closed with 4401 after the commit", async () => {
    const user = await makeUser("caller@example.com");
    const caller = await signIn(user.email);
    const others = [await signIn(user.email), await signIn(user.email)];
    const callerRegistration = await registration(user.id, caller.sessionId);
    const otherRegistrations = await Promise.all(others.map((other) => registration(user.id, other.sessionId)));
    const opened: OpenedSocket[] = [];
    let primary: { error: unknown } | undefined;
    try {
      const callerSocket = await openSocket(caller, opened);
      const otherSockets: OpenedSocket[] = [];
      for (const other of others) otherSockets.push(await openSocket(other, opened));

      const res = await revokeOthers(caller.token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revokedCount: 2 });

      for (const other of otherSockets) {
        const closed = await within(other.closed, 10_000, "A revoked session's socket close");
        expect(closed.code).toBe(4401);
        // Read as the close arrives, the session already reads as revoked: the close follows the commit.
        expect(closed.sessionRevokedAt).toBeInstanceOf(Date);
      }
      expect(await sessionStatus(caller.token)).toBe(200);
      for (const other of others) expect(await sessionStatus(other.token)).toBe(401);
      for (const id of otherRegistrations) expect(await revokedAt(id)).toBeInstanceOf(Date);
      expect(await revokedAt(callerRegistration)).toBeNull();
      expect(await sessionRevokedAt(caller.sessionId)).toBeNull();
      expect(callerSocket.socket.readyState).toBe(WebSocket.OPEN);
    } catch (error) {
      primary = { error };
    }
    const failures: unknown[] = [];
    for (const { socket, closed } of opened) {
      try {
        socket.terminate();
        await within(closed, 5_000, "A terminated socket's close");
      } catch (error) {
        failures.push(error);
      }
    }
    if (primary && failures.length > 0) {
      throw new AggregateError([primary.error, ...failures], "The case and its cleanup failed", {
        cause: primary.error,
      });
    }
    if (primary) throw primary.error;
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "The case's socket cleanup failed");
  });

  it("never revokes another user's sessions, and answers 0 when the caller has no other session", async () => {
    const owner = await makeUser("owner@example.com");
    const caller = await makeUser("single@example.com");
    const ownerSessions = [await signIn(owner.email), await signIn(owner.email)];
    const only = await signIn(caller.email);

    const res = await revokeOthers(only.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revokedCount: 0 });
    expect(await sessionStatus(only.token)).toBe(200);
    for (const session of ownerSessions) expect(await sessionStatus(session.token)).toBe(200);
  });

  it("refuses an unauthenticated call with 401 and revokes nothing", async () => {
    const user = await makeUser("victim@example.com");
    const session = await signIn(user.email);
    const res = await fetch(`${baseUrl}/api/auth/sessions/revoke-others`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(await sessionStatus(session.token)).toBe(200);
  });

  it("is matched apart from the single-session revoke route", async () => {
    const user = await makeUser("router@example.com");
    const caller = await signIn(user.email);
    const other = await signIn(user.email);
    // `revoke-others` used as a session id goes to the single revoke route, which refuses it as no UUID.
    const single = await fetch(`${baseUrl}/api/auth/sessions/revoke-others/revoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${caller.token}` },
    });
    expect(single.status).toBe(400);
    expect(await sessionStatus(other.token)).toBe(200);
  });
});

describe("POST /api/auth/login replacing the sessions of its installation (issue #1687)", () => {
  const DEVICE_ID = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
  const OTHER_DEVICE_ID = "0b7e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

  // The auth listener, the realtime hooks and the sync upgrade share one pool logged in as `semprec_data`,
  // the role the API connects as. Fixtures and assertions go through the file's superuser `pool`.
  let runtime: Pool | undefined;
  let server: Server | undefined;
  let syncServer: SyncServer | undefined;
  let baseUrl: string;
  let wsBaseUrl: string;

  // The describes above end the file's pool in their afterAll; this one opens and ends its own.
  beforeAll(async () => {
    pool = getTestPool();
    runtime = await createRuntimeRolePool(pool, "semprec_data");
  });

  beforeEach(async () => {
    if (!runtime) throw new Error("the runtime-role pool was not created");
    await resetDatabase(pool);
    wireRealtimeHooks(runtime);
    const sync = await createSyncUpgradeHandler(runtime);
    syncServer = sync;
    const http = createServer(
      createAuthRequestListener(runtime, { passwordResetMailer: createFakeMailer(), appBaseUrl: APP_BASE_URL }),
    );
    server = http;
    http.on("upgrade", (req, socket, head) => sync.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsBaseUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await syncServer?.close();
    const http = server;
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    syncServer = undefined;
    server = undefined;
  });

  afterAll(async () => {
    // The hooks are module-global; leave none bound to the pool that is ended here.
    setInvalidationHook(() => {});
    setDocUpdateHook(() => {});
    setNotificationCreatedHook(() => {});
    setNotificationReadStateHook(() => {});
    setSessionRevokedHook(() => {});
    setSempThreadInvalidationHook(() => {});
    setAgentRunEventHook(() => {});
    await runtime?.end();
    await pool?.end();
  });

  const loginBody = z.object({ token: z.string() });
  const sessionBody = z.object({ session: z.object({ id: z.string() }) });
  const sessionsBody = z.object({ sessions: z.array(z.object({ id: z.string(), deviceName: z.string().nullable() })) });

  interface SignedIn {
    token: string;
    sessionId: string;
  }

  function postLogin(email: string, fields: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, platform: "ios", ...fields }),
    });
  }

  async function signIn(email: string, fields: Record<string, string> = {}): Promise<SignedIn> {
    const res = await postLogin(email, fields);
    expect(res.status).toBe(200);
    const { token } = loginBody.parse(await res.json());
    const current = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } });
    return { token, sessionId: sessionBody.parse(await current.json()).session.id };
  }

  async function sessionStatus(token: string): Promise<number> {
    return (await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } })).status;
  }

  async function listedSessions(token: string): Promise<Array<{ id: string; deviceName: string | null }>> {
    const res = await fetch(`${baseUrl}/api/auth/sessions`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    return sessionsBody.parse(await res.json()).sessions;
  }

  async function registration(userId: string, sessionId: string): Promise<string> {
    const row = await upsertApnsSubscription(pool, {
      userId,
      sessionId,
      platform: "ios",
      deviceToken: randomUUID(),
      apnsEnvironment: "sandbox",
    });
    return row.id;
  }

  async function revokedRegistrations(userId: string): Promise<string[]> {
    const rows = await listPushSubscriptionsForUser(pool, userId);
    return rows.filter((row) => row.revokedAt !== null).map((row) => row.id);
  }

  interface OpenedSocket {
    socket: WebSocket;
    /** The close code, and whether the session still read as active the moment the close arrived. */
    closed: Promise<{ code: number; sessionActive: boolean }>;
  }

  /** The socket's close, or a rejection when it has not arrived within `ms`; the timer is cleared either way. */
  async function closeWithin(opened: OpenedSocket, ms: number): Promise<{ code: number; sessionActive: boolean }> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`The socket did not close within ${ms} ms`)), ms);
    });
    try {
      return await Promise.race([opened.closed, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Runs `work` with an opener of sync sockets and then ends every socket it opened, whether `work` passed
   * or threw. Throws the failure of `work`; when ending a socket failed as well, throws an `AggregateError`
   * that holds both and names the failure of `work` as its cause.
   */
  async function withSockets(
    work: (open: (session: SignedIn) => Promise<OpenedSocket>) => Promise<void>,
  ): Promise<void> {
    const opened: OpenedSocket[] = [];
    async function open(session: SignedIn): Promise<OpenedSocket> {
      const socket = new WebSocket(`${wsBaseUrl}/api/sync`, { headers: { Authorization: `Bearer ${session.token}` } });
      const closed = new Promise<number>((resolve) => socket.once("close", (code: number) => resolve(code))).then(
        async (code) => ({ code, sessionActive: await isSessionActive(pool, session.sessionId) }),
      );
      // Read by the case, or by the cleanup; observed here too, so a failed read is never an unhandled rejection.
      closed.catch(() => undefined);
      const entry = { socket, closed };
      opened.push(entry);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      return entry;
    }

    let primary: { error: unknown } | undefined;
    try {
      await work(open);
    } catch (error) {
      primary = { error };
    }
    const failures: unknown[] = [];
    for (const entry of opened) {
      try {
        entry.socket.terminate();
        await closeWithin(entry, 5_000);
      } catch (error) {
        failures.push(error);
      }
    }
    if (primary && failures.length > 0) {
      throw new AggregateError([primary.error, ...failures], "The case and its socket cleanup failed", {
        cause: primary.error,
      });
    }
    if (primary) throw primary.error;
    if (failures.length > 0) throw new AggregateError(failures, "The case's socket cleanup failed");
  }

  it("answers the replaced token with 401, revokes its push registrations and closes its socket with 4401 after the commit, while the new token works", async () => {
    const user = await makeUser("caller@example.com");
    const otherDevice = await signIn(user.email, { deviceId: OTHER_DEVICE_ID });
    const previous = await signIn(user.email, { deviceId: DEVICE_ID });
    const previousRegistration = await registration(user.id, previous.sessionId);
    await registration(user.id, otherDevice.sessionId);

    await withSockets(async (open) => {
      const otherDeviceSocket = await open(otherDevice);
      const previousSocket = await open(previous);

      const next = await signIn(user.email, { deviceId: DEVICE_ID });

      const closed = await closeWithin(previousSocket, 10_000);
      expect(closed.code).toBe(4401);
      // Read as the close arrives, the session is no longer active: the close follows the commit.
      expect(closed.sessionActive).toBe(false);
      expect(await sessionStatus(previous.token)).toBe(401);
      expect(await sessionStatus(next.token)).toBe(200);
      expect(await sessionStatus(otherDevice.token)).toBe(200);
      expect(await revokedRegistrations(user.id)).toEqual([previousRegistration]);
      expect(otherDeviceSocket.socket.readyState).toBe(WebSocket.OPEN);
    });
  });

  it.each<[string, Record<string, string>]>([
    ["another deviceId", { deviceId: OTHER_DEVICE_ID }],
    ["no deviceId", {}],
    ["the same deviceId from a web login, whose body fields are ignored", { platform: "web", deviceId: DEVICE_ID }],
  ])("keeps the first token working when the next login carries %s", async (_name, fields) => {
    const user = await makeUser("caller@example.com");
    const first = await signIn(user.email, { deviceId: DEVICE_ID });
    await registration(user.id, first.sessionId);

    const res = await postLogin(user.email, fields);

    expect(res.status).toBe(200);
    expect(await sessionStatus(first.token)).toBe(200);
    expect(await revokedRegistrations(user.id)).toEqual([]);
    expect(await listedSessions(first.token)).toHaveLength(2);
  });

  it("leaves another user's session with the same deviceId alone, in both directions", async () => {
    const owner = await makeUser("owner@example.com");
    const other = await makeUser("other@example.com");
    const ownerSession = await signIn(owner.email, { deviceId: DEVICE_ID });
    await registration(owner.id, ownerSession.sessionId);

    const otherSession = await signIn(other.email, { deviceId: DEVICE_ID });

    expect(await sessionStatus(ownerSession.token)).toBe(200);
    expect(await revokedRegistrations(owner.id)).toEqual([]);

    const ownerNext = await signIn(owner.email, { deviceId: DEVICE_ID });

    expect(await sessionStatus(ownerSession.token)).toBe(401);
    expect(await sessionStatus(ownerNext.token)).toBe(200);
    expect(await sessionStatus(otherSession.token)).toBe(200);
  });

  // The schedule that fails without the installation lock is forced in authActions.test.ts; this case
  // sends the logins at once through the composed route under the API's role.
  it("ends simultaneous logins with one deviceId with exactly one active session of that installation", async () => {
    const user = await makeUser("caller@example.com");
    const previous = await signIn(user.email, { deviceId: DEVICE_ID });
    const otherDevice = await signIn(user.email, { deviceId: OTHER_DEVICE_ID });

    const responses = await Promise.all(
      Array.from({ length: 4 }, () => postLogin(user.email, { deviceId: DEVICE_ID, deviceName: "Phone" })),
    );

    const tokens: string[] = [];
    for (const res of responses) {
      expect(res.status).toBe(200);
      tokens.push(loginBody.parse(await res.json()).token);
    }
    const statuses = await Promise.all(tokens.map((token) => sessionStatus(token)));
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 401)).toHaveLength(3);
    expect(await sessionStatus(previous.token)).toBe(401);
    const listed = await listedSessions(otherDevice.token);
    expect(listed.filter((session) => session.deviceName === "Phone")).toHaveLength(1);
    expect(listed).toHaveLength(2);
  });

  it("revokes nothing on a login rejected for a wrong password or by the lockout", async () => {
    const user = await makeUser("caller@example.com");
    const first = await signIn(user.email, { deviceId: DEVICE_ID });
    await registration(user.id, first.sessionId);

    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      const wrong = await postLogin(user.email, { deviceId: DEVICE_ID, password: "wrong-password" });
      expect(wrong.status).toBe(401);
      expect(await sessionStatus(first.token)).toBe(200);
    }
    const lockedOut = await postLogin(user.email, { deviceId: DEVICE_ID });

    expect(lockedOut.status).toBe(401);
    expect(await sessionStatus(first.token)).toBe(200);
    expect(await revokedRegistrations(user.id)).toEqual([]);
    expect(await listedSessions(first.token)).toHaveLength(1);
  });

  it("lists one entry per deviceId through GET /api/auth/sessions after repeated logins", async () => {
    const user = await makeUser("caller@example.com");
    for (let i = 0; i < 3; i++) await signIn(user.email, { deviceId: DEVICE_ID, deviceName: "Phone" });
    const phone = await signIn(user.email, { deviceId: DEVICE_ID, deviceName: "Phone" });
    await signIn(user.email, { deviceId: OTHER_DEVICE_ID, deviceName: "Tablet" });
    const tablet = await signIn(user.email, { deviceId: OTHER_DEVICE_ID, deviceName: "Tablet" });

    const listed = await listedSessions(tablet.token);

    expect(listed).toHaveLength(2);
    expect(listed).toEqual(
      expect.arrayContaining([
        { id: phone.sessionId, deviceName: "Phone" },
        { id: tablet.sessionId, deviceName: "Tablet" },
      ]),
    );
  });
});

describe("POST /api/auth/password-change (issue #1701)", () => {
  const ADDRESS = "203.0.113.9";
  const OTHER_ADDRESS = "198.51.100.4";
  const NEW_PASSWORD = "a-brand-new-password";

  // The auth listener runs on a pool logged in as `semprec_data`, the role the API connects as.
  // Fixtures and assertions go through the file's superuser `pool`.
  let runtime: Pool | undefined;
  let server: Server | undefined;
  let baseUrl: string;
  let mailer: FakeMailer;

  // The describes above end the file's pool in their afterAll; this one opens and ends its own.
  beforeAll(async () => {
    pool = getTestPool();
    runtime = await createRuntimeRolePool(pool, "semprec_data");
  });

  beforeEach(async () => {
    if (!runtime) throw new Error("the runtime-role pool was not created");
    await resetDatabase(pool);
    mailer = createFakeMailer();
    const http = createServer(
      createAuthRequestListener(runtime, { passwordResetMailer: mailer, appBaseUrl: APP_BASE_URL, trustProxy: true }),
    );
    server = http;
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    const http = server;
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
    server = undefined;
  });

  afterAll(async () => {
    await runtime?.end();
    await pool?.end();
  });

  const loginBody = z.object({ token: z.string() });
  const sessionBody = z.object({ session: z.object({ id: z.string() }) });
  const errorBody = z.object({ code: z.string(), details: z.object({ field: z.string() }).optional() });

  interface SignedIn {
    token: string;
    sessionId: string;
  }

  function postLogin(email: string, password: string, address = ADDRESS): Promise<Response> {
    return fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": address },
      body: JSON.stringify({ email, password, platform: "ios" }),
    });
  }

  async function signIn(email: string): Promise<SignedIn> {
    const res = await postLogin(email, PASSWORD);
    expect(res.status).toBe(200);
    const { token } = loginBody.parse(await res.json());
    const current = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } });
    return { token, sessionId: sessionBody.parse(await current.json()).session.id };
  }

  async function sessionStatus(token: string): Promise<number> {
    return (await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: `Bearer ${token}` } })).status;
  }

  /** Sends `body` as JSON, or verbatim when it is already a string. */
  function postChange(token: string | null, body: unknown, address = ADDRESS): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json", "X-Forwarded-For": address };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    return fetch(`${baseUrl}/api/auth/password-change`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  async function passwordHashOf(userId: string): Promise<string> {
    const { rows } = await pool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [
      userId,
    ]);
    const row = rows[0];
    if (!row) throw new Error("user not found");
    return row.password_hash;
  }

  async function failedAttempts(email: string): Promise<string[]> {
    const { rows } = await pool.query<{ ip: string }>(
      "SELECT host(ip) AS ip FROM login_attempts WHERE email = $1 AND succeeded = false ORDER BY attempted_at, id",
      [email],
    );
    return rows.map((row) => row.ip);
  }

  async function registration(userId: string, sessionId: string): Promise<string> {
    const row = await upsertApnsSubscription(pool, {
      userId,
      sessionId,
      platform: "ios",
      deviceToken: randomUUID(),
      apnsEnvironment: "sandbox",
    });
    return row.id;
  }

  async function revokedRegistrations(userId: string): Promise<string[]> {
    const rows = await listPushSubscriptionsForUser(pool, userId);
    return rows.filter((row) => row.revokedAt !== null).map((row) => row.id);
  }

  it("answers 200, lets the new password log in and not the old one, keeps the calling token and revokes every other session with its push registrations", async () => {
    const user = await makeUser("caller@example.com");
    const bystander = await makeUser("bystander@example.com");
    const bystanderSession = await signIn(bystander.email);
    const calling = await signIn(user.email);
    const others = [await signIn(user.email), await signIn(user.email)];
    await registration(user.id, calling.sessionId);
    const otherRegistrations = [
      await registration(user.id, others[0]!.sessionId),
      await registration(user.id, others[1]!.sessionId),
    ];

    const res = await postChange(calling.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await postLogin(user.email, PASSWORD)).status).toBe(401);
    expect((await postLogin(user.email, NEW_PASSWORD)).status).toBe(200);
    expect(await sessionStatus(calling.token)).toBe(200);
    for (const other of others) expect(await sessionStatus(other.token)).toBe(401);
    expect((await revokedRegistrations(user.id)).sort()).toEqual([...otherRegistrations].sort());
    expect(await sessionStatus(bystanderSession.token)).toBe(200);
    expect((await postLogin(bystander.email, PASSWORD)).status).toBe(200);
  });

  it("answers a wrong currentPassword with 403 reauthentication_failed, records a failed attempt for the caller's address and keeps the calling token and the password", async () => {
    const user = await makeUser("caller@example.com");
    const calling = await signIn(user.email);
    const second = await signIn(user.email);

    const res = await postChange(calling.token, { currentPassword: "wrong-password", newPassword: NEW_PASSWORD });

    expect(res.status).toBe(403);
    expect(errorBody.parse(await res.json()).code).toBe("reauthentication_failed");
    expect(await failedAttempts(user.email)).toEqual([ADDRESS]);
    expect(await sessionStatus(calling.token)).toBe(200);
    expect(await sessionStatus(second.token)).toBe(200);
    expect((await postLogin(user.email, NEW_PASSWORD, OTHER_ADDRESS)).status).toBe(401);
    expect((await postLogin(user.email, PASSWORD, OTHER_ADDRESS)).status).toBe(200);
  });

  it("answers 403 reauthentication_failed to the correct currentPassword while failed logins lock the address out, and 200 from another address", async () => {
    const user = await makeUser("caller@example.com");
    const calling = await signIn(user.email);
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      expect((await postLogin(user.email, "wrong-password")).status).toBe(401);
    }
    const hashBefore = await passwordHashOf(user.id);

    const locked = await postChange(calling.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(locked.status).toBe(403);
    expect(errorBody.parse(await locked.json()).code).toBe("reauthentication_failed");
    expect(await passwordHashOf(user.id)).toBe(hashBefore);
    expect(await failedAttempts(user.email)).toEqual(Array.from({ length: LOCKOUT_THRESHOLD + 1 }, () => ADDRESS));
    expect(await sessionStatus(calling.token)).toBe(200);

    const elsewhere = await postChange(
      calling.token,
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      OTHER_ADDRESS,
    );

    expect(elsewhere.status).toBe(200);
    expect(await passwordHashOf(user.id)).not.toBe(hashBefore);
  });

  it("locks login out of the address after LOCKOUT_THRESHOLD wrong currentPasswords", async () => {
    const user = await makeUser("caller@example.com");
    const calling = await signIn(user.email);
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      const res = await postChange(calling.token, { currentPassword: "wrong-password", newPassword: NEW_PASSWORD });
      expect(res.status).toBe(403);
    }

    expect((await postLogin(user.email, PASSWORD)).status).toBe(401);
    expect((await postLogin(user.email, PASSWORD, OTHER_ADDRESS)).status).toBe(200);
    expect(await sessionStatus(calling.token)).toBe(200);
  });

  it("records the failed attempt for the socket peer, not for X-Forwarded-For, on a listener that does not trust the proxy", async () => {
    if (!runtime) throw new Error("the runtime-role pool was not created");
    const user = await makeUser("caller@example.com");
    const calling = await signIn(user.email);
    const untrusting = createServer(
      createAuthRequestListener(runtime, { passwordResetMailer: mailer, appBaseUrl: APP_BASE_URL }),
    );
    await new Promise<void>((resolve) => untrusting.listen(0, "127.0.0.1", resolve));
    try {
      const address = untrusting.address();
      if (!address || typeof address === "string") throw new Error("expected a bound TCP address");

      const res = await fetch(`http://127.0.0.1:${address.port}/api/auth/password-change`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": ADDRESS,
          Authorization: `Bearer ${calling.token}`,
        },
        body: JSON.stringify({ currentPassword: "wrong-password", newPassword: NEW_PASSWORD }),
      });

      expect(res.status).toBe(403);
      expect(await failedAttempts(user.email)).toEqual(["127.0.0.1"]);
    } finally {
      await new Promise<void>((resolve) => untrusting.close(() => resolve()));
    }
  });

  it("answers 400 password_reset_token_consumed to a reset link that was requested before the change", async () => {
    const user = await makeUser("caller@example.com");
    const calling = await signIn(user.email);
    const requested = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email }),
    });
    expect(requested.status).toBe(200);
    const sent = mailer.sent.at(-1);
    if (!sent) throw new Error("expected a reset email");
    const token = tokenFromResetUrl(sent.resetUrl);

    const changed = await postChange(calling.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(changed.status).toBe(200);

    const consumed = await fetch(`${baseUrl}/api/auth/password-reset/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: "from-the-old-link" }),
    });

    expect(consumed.status).toBe(400);
    expect(errorBody.parse(await consumed.json()).code).toBe("password_reset_token_consumed");
    expect((await postLogin(user.email, "from-the-old-link")).status).toBe(401);
    expect((await postLogin(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it.each<[string, unknown, string]>([
    ["a newPassword of 7 characters", { currentPassword: PASSWORD, newPassword: "1234567" }, "newPassword"],
    ["an empty newPassword", { currentPassword: PASSWORD, newPassword: "" }, "newPassword"],
    ["a missing newPassword", { currentPassword: PASSWORD }, "newPassword"],
    ["a non-string newPassword", { currentPassword: PASSWORD, newPassword: 12345678 }, "newPassword"],
    ["a missing currentPassword", { newPassword: NEW_PASSWORD }, "currentPassword"],
    ["a non-string currentPassword", { currentPassword: 12345678, newPassword: NEW_PASSWORD }, "currentPassword"],
    ["an empty currentPassword", { currentPassword: "", newPassword: NEW_PASSWORD }, "currentPassword"],
  ])("answers %s with 400 validation_failed naming the field, and records no attempt", async (_name, body, field) => {
    const user = await makeUser("caller@example.com");
    const calling = await signIn(user.email);
    const hashBefore = await passwordHashOf(user.id);

    const res = await postChange(calling.token, body);

    expect(res.status).toBe(400);
    expect(errorBody.parse(await res.json())).toEqual({ code: "validation_failed", details: { field } });
    expect(await failedAttempts(user.email)).toEqual([]);
    expect(await passwordHashOf(user.id)).toBe(hashBefore);
    expect(await sessionStatus(calling.token)).toBe(200);
  });

  it.each<[string, string]>([
    ["the JSON literal null", "null"],
    ["a JSON array", "[]"],
    ["malformed JSON", "{"],
  ])("answers a body that is %s with 400 validation_failed and changes nothing", async (_name, raw) => {
    const user = await makeUser("caller@example.com");
    const calling = await signIn(user.email);
    const hashBefore = await passwordHashOf(user.id);

    const res = await postChange(calling.token, raw);

    expect(res.status).toBe(400);
    expect(errorBody.parse(await res.json()).code).toBe("validation_failed");
    expect(await failedAttempts(user.email)).toEqual([]);
    expect(await passwordHashOf(user.id)).toBe(hashBefore);
  });

  it("answers 413 to a body over the 64 KiB cap and changes nothing", async () => {
    const user = await makeUser("caller@example.com");
    const calling = await signIn(user.email);
    const hashBefore = await passwordHashOf(user.id);

    const res = await postChange(calling.token, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      padding: "x".repeat(64 * 1024),
    });

    expect(res.status).toBe(413);
    expect(await passwordHashOf(user.id)).toBe(hashBefore);
    expect(await failedAttempts(user.email)).toEqual([]);
  });

  it("refuses an unauthenticated call with 401 before reading the body, and changes nothing", async () => {
    const user = await makeUser("caller@example.com");
    const session = await signIn(user.email);
    const hashBefore = await passwordHashOf(user.id);

    const res = await postChange(null, "{");

    expect(res.status).toBe(401);
    expect(await passwordHashOf(user.id)).toBe(hashBefore);
    expect(await failedAttempts(user.email)).toEqual([]);
    expect(await sessionStatus(session.token)).toBe(200);
  });

  it("answers 404 to another method on the path", async () => {
    const user = await makeUser("caller@example.com");
    const calling = await signIn(user.email);

    const res = await fetch(`${baseUrl}/api/auth/password-change`, {
      headers: { Authorization: `Bearer ${calling.token}` },
    });

    expect(res.status).toBe(404);
  });

  it("answers two simultaneous changes with the same currentPassword with one 200 and one 403", async () => {
    const user = await makeUser("caller@example.com");
    const callers = [
      { session: await signIn(user.email), newPassword: "first-new-password" },
      { session: await signIn(user.email), newPassword: "second-new-password" },
    ];

    const responses = await Promise.all(
      callers.map((caller) =>
        postChange(caller.session.token, { currentPassword: PASSWORD, newPassword: caller.newPassword }),
      ),
    );

    const statuses = responses.map((res) => res.status);
    expect([...statuses].sort()).toEqual([200, 403]);
    const refused = responses.find((res) => res.status === 403);
    if (!refused) throw new Error("expected one refused change");
    expect(errorBody.parse(await refused.json()).code).toBe("reauthentication_failed");
    const winner = callers.find((_caller, index) => statuses[index] === 200);
    const loser = callers.find((_caller, index) => statuses[index] === 403);
    if (!winner || !loser) throw new Error("expected one accepted and one refused change");
    expect((await postLogin(user.email, winner.newPassword, OTHER_ADDRESS)).status).toBe(200);
    expect((await postLogin(user.email, loser.newPassword, OTHER_ADDRESS)).status).toBe(401);
    expect(await sessionStatus(winner.session.token)).toBe(200);
    expect(await sessionStatus(loser.session.token)).toBe(401);
  });

  it("answers 401 and writes no new hash when a suspension of the caller's account commits while the request is in flight", async () => {
    const admin = await createUser(pool, {
      tenantId: await tenantForNextTestUser(pool),
      email: "admin@example.com",
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
    });
    const user = await makeUser("caller@example.com");
    const calling = await signIn(user.email);
    const hashBefore = await passwordHashOf(user.id);
    let releaseSuspension!: () => void;
    const suspensionHeld = new Promise<void>((resolve) => {
      releaseSuspension = resolve;
    });
    let markSuspended!: () => void;
    const suspendedUncommitted = new Promise<void>((resolve) => {
      markSuspended = resolve;
    });
    const suspension = withTransaction(pool, async (client) => {
      await suspendAccount(client, { actorUserId: admin.id, targetUserId: user.id });
      markSuspended();
      await suspensionHeld;
    });
    // Awaited below; observed here too, so an early failure is never an unhandled rejection.
    suspension.catch(() => undefined);
    await Promise.race([suspendedUncommitted, suspension]);

    // The request reads the tenant as active, because the suspension is not committed, and then waits for it.
    const responding = postChange(calling.token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    responding.catch(() => undefined);
    try {
      await vi.waitFor(async () => {
        const { rows } = await pool.query<{ waiting: number }>(
          "SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted",
        );
        expect(rows[0]?.waiting).toBeGreaterThan(0);
      });
    } finally {
      releaseSuspension();
    }
    await suspension;

    const res = await responding;
    expect(res.status).toBe(401);
    expect(errorBody.parse(await res.json()).code).toBe("unauthorized");
    expect(await passwordHashOf(user.id)).toBe(hashBefore);
    expect(await failedAttempts(user.email)).toEqual([]);
    expect(await sessionStatus(calling.token)).toBe(401);
  });
});
