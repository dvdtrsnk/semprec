import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type RequestListener, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg, { type Pool } from "pg";
import { WebSocket } from "ws";
import { z } from "zod";
import { runInTenant, runAsSystem } from "@alldots/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  tenantForNextTestUser,
} from "@alldots/data/testSupport";
import {
  seedSystem,
  createChokePoint,
  getDatabaseByModuleId,
  withTransaction,
  insertValueLink,
  setInvalidationHook,
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
  type InvalidationEvent,
  type PasswordResetMailer,
  type UserRow,
} from "@alldots/data";
import { wireRealtimeHooks, type SyncServer } from "@alldots/realtime";
import { createSyncUpgradeHandler } from "../syncHandler.js";
import { createAuthRequestListener, SESSION_COOKIE_NAME, type AuthRequestListenerOptions } from "../authHandler.js";
import { createClientIpThrottle } from "../clientIpThrottle.js";

const PASSWORD = "s3cret-password";
const NEW_PASSWORD = "a-brand-new-password";
const APP_BASE_URL = "https://app.example.test";
const ADDRESS = "203.0.113.9";
const OTHER_ADDRESS = "198.51.100.4";
const DEVICE_ID = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const OTHER_DEVICE_ID = "0b7e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

const loginBody = z.object({ token: z.string() });
const sessionBody = z.object({ session: z.object({ id: z.string() }) });
const errorBody = z.object({ code: z.string(), details: z.object({ field: z.string() }).optional() });

let pool: Pool;
let passwordHash: Promise<string> | undefined;

beforeAll(() => {
  pool = getTestPool();
});

afterAll(async () => {
  await pool.end();
});

async function makeUser(email = "person@example.com", role?: "admin"): Promise<UserRow> {
  return createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email,
    passwordHash: await (passwordHash ??= hashPassword(PASSWORD)),
    ...(role ? { role } : {}),
  });
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const cookie = (value: string) => ({ Cookie: `${SESSION_COOKIE_NAME}=${value}` });

function sessionCookieFrom(res: Response): string {
  const match = res.headers.get("set-cookie")?.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]*)`));
  if (!match?.[1]) throw new Error(`expected a ${SESSION_COOKIE_NAME} cookie`);
  return match[1];
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

function tokenFromResetUrl(resetUrl: string | undefined): string {
  const token = resetUrl ? new URLSearchParams(new URL(resetUrl).hash.slice(1)).get("token") : null;
  if (!token) throw new Error(`expected a token in the URL fragment of ${resetUrl}`);
  return token;
}

async function countOf(sql: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(sql);
  return Number(rows[0]?.count);
}

interface Listening {
  url: string;
  close(): Promise<void>;
}

/**
 * Binds `127.0.0.1`, or with `dualStack` every address, so a request to `127.0.0.1` arrives from the IPv4-mapped
 * IPv6 peer `::ffff:127.0.0.1`.
 */
async function listen(listener: RequestListener, sync?: SyncServer, dualStack = false): Promise<Listening> {
  const server: Server = createServer(listener);
  if (sync) server.on("upgrade", (req, socket, head) => sync.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) =>
    dualStack ? server.listen(0, resolve) : server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return {
    url: `127.0.0.1:${address.port}`,
    async close() {
      try {
        await sync?.close();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}

function authListener(listenerPool: Pool, options: Partial<AuthRequestListenerOptions> = {}): RequestListener {
  return createAuthRequestListener(listenerPool, {
    passwordResetMailer: createFakeMailer(),
    appBaseUrl: APP_BASE_URL,
    ...options,
  });
}

/** HTTP helpers against the listener at `host()`. */
function createApi(host: () => string) {
  const url = (path: string) => `http://${host()}${path}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url(path), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const login = (email: string, fields: Record<string, unknown> = {}, headers?: Record<string, string>) =>
    post("/api/auth/login", { email, password: PASSWORD, platform: "web", ...fields }, headers);
  const session = (headers: Record<string, string> = {}) => fetch(url("/api/auth/session"), { headers });
  const nativeToken = async (email: string, fields: Record<string, unknown> = {}, headers?: Record<string, string>) => {
    const res = await login(email, { platform: "ios", ...fields }, headers);
    expect(res.status).toBe(200);
    return loginBody.parse(await res.json()).token;
  };
  const signIn = async (email: string, fields: Record<string, unknown> = {}, headers?: Record<string, string>) => {
    const token = await nativeToken(email, fields, headers);
    const current = await session(bearer(token));
    return { token, sessionId: sessionBody.parse(await current.json()).session.id };
  };
  const sessionStatus = async (token: string) => (await session(bearer(token))).status;
  /** Logs in on `platform` and returns the credential headers it issued: a cookie for web, a bearer otherwise. */
  const credentials = async (email: string, platform: "web" | "ios" | "macos") => {
    if (platform !== "web") return bearer(await nativeToken(email, { platform }));
    const res = await login(email);
    expect(res.status).toBe(200);
    return cookie(sessionCookieFrom(res));
  };
  return { url, post, login, session, nativeToken, signIn, sessionStatus, credentials };
}

type SignedIn = { token: string; sessionId: string };

async function registration(userId: string, sessionId: string, kind: "apns" | "webPush" = "apns"): Promise<string> {
  const row =
    kind === "apns"
      ? await upsertApnsSubscription(pool, {
          userId,
          sessionId,
          platform: "ios",
          deviceToken: randomUUID(),
          apnsEnvironment: "sandbox",
        })
      : await upsertWebPushSubscription(pool, {
          userId,
          sessionId,
          endpoint: `https://push.example.test/${randomUUID()}`,
          p256dh: "key",
          authSecret: "secret",
        });
  return row.id;
}

async function revokedRegistrations(userId: string): Promise<string[]> {
  const rows = await listPushSubscriptionsForUser(pool, userId);
  return rows
    .filter((row) => row.revokedAt !== null)
    .map((row) => row.id)
    .sort();
}

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

interface OpenedSocket {
  socket: WebSocket;
  /** Whether the session was still active the moment the close arrived. */
  closed: Promise<{ code: number; sessionActive: boolean }>;
}

/**
 * Runs `work` with an `open` that connects `/api/sync` as a session, then ends every opened socket whether `work`
 * passed or threw; a cleanup failure never replaces the failure of `work`.
 */
async function withSockets(
  host: string,
  work: (open: (session: SignedIn) => Promise<OpenedSocket>) => Promise<void>,
): Promise<void> {
  const opened: OpenedSocket[] = [];
  async function open(session: SignedIn): Promise<OpenedSocket> {
    const socket = new WebSocket(`ws://${host}/api/sync`, { headers: bearer(session.token) });
    const closed = new Promise<number>((resolve) => socket.once("close", (code: number) => resolve(code))).then(
      async (code) => ({ code, sessionActive: await isSessionActive(pool, session.sessionId) }),
    );
    // Observed here too, so a failed read is never an unhandled rejection.
    closed.catch(() => undefined);
    // Recorded before it opens, so the cleanup ends every started socket, including one that failed to open.
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
      await within(entry.closed, 5_000, "A terminated socket's close");
    } catch (error) {
      failures.push(error);
    }
  }
  if (primary && failures.length > 0)
    throw new AggregateError([primary.error, ...failures], "The case and its socket cleanup failed", {
      cause: primary.error,
    });
  if (primary) throw primary.error;
  if (failures.length > 0) throw new AggregateError(failures, "The case's socket cleanup failed");
}

describe("createAuthRequestListener", () => {
  let server: Listening;
  let mailer: FakeMailer;
  const api = createApi(() => server.url);

  beforeEach(async () => {
    await resetDatabase(pool);
    mailer = createFakeMailer();
    server = await listen(authListener(pool, { passwordResetMailer: mailer, trustProxy: true }), undefined, true);
  });

  afterEach(() => server.close());

  describe("POST /api/auth/login", () => {
    it.each(["web", "ios"] as const)(
      "logs a %s client in with its credential kind and a body with the user's public fields",
      async (platform) => {
        const user = await makeUser();
        const res = await api.login(user.email, { platform });

        expect(res.status).toBe(200);
        const body: unknown = await res.json();
        expect(body).toMatchObject({ user: { email: user.email, displayName: null, role: "member" } });
        expect(body).not.toHaveProperty("user.passwordHash");
        if (platform === "web") {
          // The token never appears in a web body.
          expect(body).not.toHaveProperty("token");
          expect(sessionCookieFrom(res)).toBeTruthy();
          expect(res.headers.get("set-cookie")).toContain(`Max-Age=${365 * 24 * 60 * 60}`);
        } else {
          expect(body).toMatchObject({ token: expect.stringMatching(/.+/) });
          expect(res.headers.get("set-cookie")).toBeNull();
        }
      },
    );

    it("returns the stored displayName and an admin's role at login and through the session", async () => {
      const user = await makeUser("admin@example.com", "admin");
      // Set directly to exercise the read path.
      await pool.query("UPDATE users SET display_name = $2 WHERE id = $1", [user.id, "Ada Lovelace"]);

      const res = await api.login(user.email, { platform: "ios" });
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      expect(body).toMatchObject({ user: { displayName: "Ada Lovelace", role: "admin" } });
      const session = await api.session(bearer(loginBody.parse(body).token));
      expect(await session.json()).toMatchObject({
        user: { email: user.email, displayName: "Ada Lovelace", role: "admin" },
      });
    });

    it("answers a wrong password and an unknown email with the same 401, and an invalid platform with 400", async () => {
      const user = await makeUser();
      const wrongPassword = await api.login(user.email, { password: "wrong" });
      const unknownEmail = await api.login("nobody@example.com", { password: "wrong" });

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(await wrongPassword.json()).toEqual(await unknownEmail.json());
      expect((await api.login(user.email, { platform: "android" })).status).toBe(400);
    });

    it("locks out the correct password after LOCKOUT_THRESHOLD failures, recording every failed attempt", async () => {
      const user = await makeUser();
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++)
        expect((await api.login(user.email, { password: "wrong" })).status).toBe(401);

      expect((await api.login(user.email)).status).toBe(401);
      expect(await countOf("SELECT count(*) FROM login_attempts WHERE succeeded = false")).toBe(LOCKOUT_THRESHOLD + 1);
      expect(await countOf("SELECT count(*) FROM sessions")).toBe(0);
    });

    it("accepts the correct password below LOCKOUT_THRESHOLD and records the success with its session", async () => {
      const user = await makeUser();
      for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++)
        expect((await api.login(user.email, { password: "wrong" })).status).toBe(401);

      expect((await api.login(user.email)).status).toBe(200);
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
      const from = (address: string) => ({ "X-Forwarded-For": address });
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++)
        expect((await api.login(user.email, { password: "wrong" }, from(ADDRESS))).status).toBe(401);

      expect((await api.login(user.email, {}, from(OTHER_ADDRESS))).status).toBe(200);
      expect((await api.login(user.email, {}, from(ADDRESS))).status).toBe(401);
    });

    describe("device identity", () => {
      const SAFARI_MAC_UA =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
      const noDevice = { device_id: null, device_name: null, device_kind: null, os_version: null, app_version: null };
      const safari = { ...noDevice, device_name: "Safari", device_kind: "browser", os_version: "macOS" };

      async function postDeviceLogin(fields: Record<string, unknown>, userAgent?: string): Promise<Response> {
        const user = await makeUser();
        return api.login(user.email, fields, userAgent ? { "User-Agent": userAgent } : {});
      }

      async function deviceRows() {
        const { rows } = await pool.query<{
          device_id: string | null;
          device_name: string | null;
          device_kind: string | null;
          os_version: string | null;
          app_version: string | null;
        }>("SELECT device_id, device_name, device_kind, os_version, app_version FROM sessions");
        return rows;
      }

      it.each([
        {
          name: "stores the trimmed device fields of a native login",
          fields: {
            platform: "ios",
            deviceId: DEVICE_ID,
            deviceName: " iPhone 17 Pro ",
            deviceKind: "iphone",
            osVersion: "26.0",
            appVersion: "1.2.3",
          },
          expected: {
            device_id: DEVICE_ID,
            device_name: "iPhone 17 Pro",
            device_kind: "iphone",
            os_version: "26.0",
            app_version: "1.2.3",
          },
        },
        {
          name: "accepts a macos login with deviceKind mac",
          fields: { platform: "macos", deviceKind: "mac" },
          expected: { ...noDevice, device_kind: "mac" },
        },
        {
          name: "leaves the device columns NULL when a native login sends none",
          fields: { platform: "ios" },
          expected: noDevice,
        },
        {
          name: "accepts a deviceName of exactly 100 characters",
          fields: { platform: "ios", deviceName: "a".repeat(100) },
          expected: { ...noDevice, device_name: "a".repeat(100) },
        },
        {
          name: "derives the device of a web login from the User-Agent and ignores body fields",
          fields: {
            platform: "web",
            deviceId: DEVICE_ID,
            deviceName: "iPhone 17 Pro",
            deviceKind: "iphone",
            osVersion: "26.0",
            appVersion: "9.9.9",
          },
          userAgent: SAFARI_MAC_UA,
          expected: safari,
        },
        {
          name: "does not reject a web login whose device fields are invalid",
          fields: { platform: "web", deviceKind: "phone", deviceId: "nope" },
          userAgent: SAFARI_MAC_UA,
          expected: safari,
        },
      ])("$name", async ({ fields, userAgent, expected }) => {
        const res = await postDeviceLogin(fields, userAgent);
        expect(res.status).toBe(200);
        expect(await deviceRows()).toEqual([expected]);
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
      ])("rejects %s with 400 naming the field and creates no session", async (_label, fields, field) => {
        const res = await postDeviceLogin(fields);
        expect(res.status).toBe(400);
        expect(errorBody.parse(await res.json())).toMatchObject({ code: "validation_failed", details: { field } });
        expect(await deviceRows()).toEqual([]);
      });
    });
  });

  describe("GET /api/auth/sessions", () => {
    it("returns only active caller sessions with the exact public fields", async () => {
      const user = await makeUser();
      const other = await makeUser("other@example.com");
      const cookies: string[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await api.login(user.email);
        expect(res.status).toBe(200);
        cookies.push(sessionCookieFrom(res));
      }
      expect((await api.login(other.email)).status).toBe(200);
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM sessions WHERE user_id = $1 ORDER BY created_at, id",
        [user.id],
      );
      const ids = rows.map((row) => row.id);
      expect(ids).toHaveLength(5);
      // Sessions without device identity cannot be created by the current login route.
      await pool.query(
        "UPDATE sessions SET device_id = NULL, device_kind = NULL, device_name = NULL, os_version = NULL, app_version = NULL WHERE id = $1",
        [ids[0]],
      );
      await pool.query("UPDATE sessions SET last_seen_at = now() - interval '1 hour' WHERE id = $1", [ids[1]]);
      await pool.query("UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE id = $1", [ids[2]]);
      await pool.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [ids[3]]);
      await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [ids[4]]);

      const response = await fetch(api.url("/api/auth/sessions"), { headers: cookie(cookies[0]!) });
      expect(response.status).toBe(200);
      const body = z.object({ sessions: z.array(z.record(z.string(), z.unknown())) }).parse(await response.json());
      expect(body.sessions).toEqual([
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
      ]);
      for (const session of body.sessions)
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
      expect((await fetch(api.url("/api/auth/sessions"))).status).toBe(401);
    });
  });

  describe("GET /api/auth/session", () => {
    /** The login API cannot backdate a session, so lifetimes are set directly. */
    const setLifetime = (userId: string, assignments: string, params: unknown[] = []) =>
      withTransaction(pool, (client) =>
        client.query(`UPDATE sessions SET ${assignments} WHERE user_id = $1`, [userId, ...params]),
      );

    it.each([
      ["ios", 90],
      ["web", 30],
    ] as const)(
      "slides a %s session through authenticated HTTP without changing its response",
      async (platform, days) => {
        const user = await makeUser();
        const headers = await api.credentials(user.email, platform);
        await setLifetime(user.id, "expires_at = now() + interval '1 day'");
        const expiryOf = async () =>
          (
            await pool.query<{ expires_at: Date }>("SELECT expires_at FROM sessions WHERE user_id = $1", [user.id])
          ).rows[0]?.expires_at.getTime() ?? 0;

        const first = await api.session(headers);
        expect(first.status).toBe(200);
        const firstBody: unknown = await first.json();
        const firstExpiry = await expiryOf();
        expect(Math.abs(firstExpiry - Date.now() - days * 86400_000)).toBeLessThan(60_000);
        const second = await api.session(headers);
        expect(second.status).toBe(200);
        expect(await second.json()).toEqual(firstBody);
        expect(await expiryOf()).toBeGreaterThanOrEqual(firstExpiry);
      },
    );

    it.each([
      ["ios", 364, true, 1],
      ["web", 300, false, 30],
      ["web", 340, true, 25],
    ] as const)(
      "caps an active %s session created %i days ago at its absolute lifetime when due",
      async (platform, ageDays, capped, idleDays) => {
        const user = await makeUser();
        const headers = await api.credentials(user.email, platform);
        await setLifetime(
          user.id,
          "created_at = now() - make_interval(days => $2::int), expires_at = now() + interval '1 hour'",
          [ageDays],
        );
        expect((await api.session(headers)).status).toBe(200);
        const { rows } = await pool.query<{ capped: boolean; idle_seconds: number }>(
          "SELECT expires_at = created_at + interval '365 days' AS capped, extract(epoch FROM (expires_at - now()))::double precision AS idle_seconds FROM sessions WHERE user_id = $1",
          [user.id],
        );
        expect(rows[0]?.capped).toBe(capped);
        expect(Math.abs((rows[0]?.idle_seconds ?? 0) - idleDays * 86400)).toBeLessThan(60);
      },
    );

    it("rejects an expired web session over HTTP without renewing it", async () => {
      const user = await makeUser();
      const headers = await api.credentials(user.email, "web");
      await setLifetime(user.id, "created_at = now() - interval '31 days', expires_at = now() - interval '1 day'");
      expect((await api.session(headers)).status).toBe(401);
      const result = await pool.query<{ expired: boolean }>(
        "SELECT expires_at < now() AS expired FROM sessions WHERE user_id = $1",
        [user.id],
      );
      expect(result.rows).toEqual([{ expired: true }]);
    });

    it.each([
      ["no credentials", async () => ({})],
      ["a garbage bearer token", async () => bearer("garbage")],
      [
        "a web session's token presented as a bearer token",
        async () =>
          bearer(decodeURIComponent(sessionCookieFrom(await api.login((await makeUser()).email, { platform: "web" })))),
      ],
      [
        "an ios session's token presented as a cookie",
        async () => cookie(await api.nativeToken((await makeUser()).email)),
      ],
      [
        "a macos session's token presented as a cookie",
        async () => cookie(await api.nativeToken((await makeUser()).email, { platform: "macos" })),
      ],
    ])("answers 401 to %s", async (_name, headers) => {
      expect((await api.session(await headers())).status).toBe(401);
    });
  });

  describe("session revocation", () => {
    const revoke = (sessionId: string, token: string) =>
      fetch(api.url(`/api/auth/sessions/${sessionId}/revoke`), { method: "POST", headers: bearer(token) });

    it("logs out only the session used to authenticate the logout call, and refuses an unauthenticated logout", async () => {
      const user = await makeUser();
      const tokenA = await api.nativeToken(user.email, { platform: "macos" });
      const tokenB = await api.nativeToken(user.email);

      expect((await fetch(api.url("/api/auth/logout"), { method: "POST" })).status).toBe(401);
      expect((await fetch(api.url("/api/auth/logout"), { method: "POST", headers: bearer(tokenA) })).status).toBe(200);
      expect(await api.sessionStatus(tokenA)).toBe(401);
      expect(await api.sessionStatus(tokenB)).toBe(200);
    });

    it("lets an authenticated user revoke one of their other sessions", async () => {
      const user = await makeUser();
      const active = await api.signIn(user.email);
      const target = await api.signIn(user.email, { platform: "macos" });

      const res = await revoke(target.sessionId, active.token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revoked: true });
      expect(await api.sessionStatus(target.token)).toBe(401);
      expect(await api.sessionStatus(active.token)).toBe(200);
    });

    it("refuses to revoke another user's session", async () => {
      const owner = await api.signIn((await makeUser("owner@example.com")).email);
      const attacker = await api.signIn((await makeUser("attacker@example.com")).email);

      const res = await revoke(owner.sessionId, attacker.token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revoked: false });
      expect(await api.sessionStatus(owner.token)).toBe(200);
    });

    it("returns 400 validation_failed naming 'id' for a non-UUID session id", async () => {
      const token = await api.nativeToken((await makeUser()).email);
      const res = await revoke("foo", token);
      expect(res.status).toBe(400);
      expect(errorBody.parse(await res.json())).toEqual({ code: "validation_failed", details: { field: "id" } });
    });
  });

  describe("POST /api/auth/password-reset/request", () => {
    it("emails a signed reset link for a known email and answers an unknown email identically without mail", async () => {
      const user = await makeUser();
      const known = await api.post("/api/auth/password-reset/request", { email: user.email });
      const unknown = await api.post("/api/auth/password-reset/request", { email: "nobody@example.com" });

      expect(known.status).toBe(200);
      expect(await known.json()).toEqual({ ok: true });
      expect(unknown.status).toBe(200);
      expect(await unknown.json()).toEqual({ ok: true });
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.to).toBe(user.email);
      expect(mailer.sent[0]!.resetUrl.startsWith(`${APP_BASE_URL}/?page=password-reset#token=`)).toBe(true);
      expect(new URL(mailer.sent[0]!.resetUrl).searchParams.has("token")).toBe(false);
      expect((await api.post("/api/auth/password-reset/request", {})).status).toBe(400);
    });

    it("answers a known email before the mail send has resolved", async () => {
      const user = await makeUser();
      const sent: Array<{ to: string; resetUrl: string }> = [];
      let release!: () => void;
      const pendingSend = new Promise<void>((resolve) => (release = resolve));
      const deferred = await listen(
        authListener(pool, {
          passwordResetMailer: {
            sendPasswordResetEmail(input) {
              sent.push(input);
              return pendingSend;
            },
          },
        }),
      );
      try {
        const res = await createApi(() => deferred.url).post("/api/auth/password-reset/request", { email: user.email });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(sent.map((input) => input.to)).toEqual([user.email]);
      } finally {
        release();
        await deferred.close();
      }
    });
  });

  describe("POST /api/auth/password-reset/consume", () => {
    async function requestReset(email: string): Promise<string> {
      await api.post("/api/auth/password-reset/request", { email });
      return tokenFromResetUrl(mailer.sent.at(-1)?.resetUrl);
    }

    const consume = (body: unknown) => api.post("/api/auth/password-reset/consume", body);

    it("changes the password once, then answers the consumed token with a deterministic 'consumed' response", async () => {
      const user = await makeUser();
      const token = await requestReset(user.email);

      const res = await consume({ token, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect((await api.login(user.email)).status).toBe(401);
      expect((await api.login(user.email, { password: NEW_PASSWORD })).status).toBe(200);

      const second = await consume({ token, newPassword: "second-new-password" });
      expect(second.status).toBe(400);
      expect(errorBody.parse(await second.json()).code).toBe("password_reset_token_consumed");
    });

    it("rejects an unknown token with a deterministic 'invalid' response", async () => {
      const res = await consume({ token: "not-a-real-token", newPassword: "whatever-password" });
      expect(res.status).toBe(400);
      expect(errorBody.parse(await res.json()).code).toBe("password_reset_token_invalid");
    });

    it("rejects a short or missing newPassword without consuming the token", async () => {
      const token = await requestReset((await makeUser()).email);
      const short = await consume({ token, newPassword: "short" });
      expect(short.status).toBe(400);
      expect(errorBody.parse(await short.json()).code).toBe("validation_failed");
      expect((await consume({ token })).status).toBe(400);
      expect((await consume({ token, newPassword: NEW_PASSWORD })).status).toBe(200);
    });
  });

  describe("per-address throttle", () => {
    let throttled: Listening;
    let onThrottledArrival: () => void;
    const throttledApi = createApi(() => throttled.url);

    beforeEach(async () => {
      onThrottledArrival = () => {};
      const listener = authListener(pool, {
        passwordResetMailer: mailer,
        trustProxy: true,
        clientIpThrottle: createClientIpThrottle({
          limits: {
            login: { maxEvents: 3, windowSeconds: 900 },
            passwordResetRequest: { maxEvents: 2, windowSeconds: 3600 },
            passwordResetConsume: { maxEvents: 2, windowSeconds: 3600 },
          },
        }),
      });
      throttled = await listen((req, res) => {
        onThrottledArrival();
        listener(req, res);
      });
    });

    afterEach(() => throttled.close());

    const post = (path: string, from: string, body: unknown) =>
      throttledApi.post(path, body, { "X-Forwarded-For": from });
    const login = (from: string, email: string, password: string) =>
      post("/api/auth/login", from, { email, password, platform: "web" });

    async function postBurstWithHeldBodies(path: string, bodies: unknown[]): Promise<number[]> {
      let arrived = 0;
      let allArrived!: () => void;
      const allArrivedPromise = new Promise<void>((resolve) => (allArrived = resolve));
      onThrottledArrival = () => {
        if (++arrived === bodies.length) allArrived();
      };
      const requests = bodies.map((body) => {
        const payload = JSON.stringify(body);
        const req = httpRequest(throttledApi.url(path), {
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
        // The last arrival's listener runs synchronously through the throttle check before any body is sent, so
        // every request reaches that check before any body is read.
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

    const countStatuses = (statuses: number[]) =>
      statuses.reduce<Record<number, number>>(
        (counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }),
        {},
      );

    async function expectRateLimited(res: Response): Promise<void> {
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: "Too many attempts; try again later", code: "rate_limited" });
      expect(res.headers.get("retry-after")).toMatch(/^[1-9][0-9]*$/);
    }

    it("refuses login from an address after its failed logins across different emails, even with correct credentials", async () => {
      const user = await makeUser();
      expect((await login(ADDRESS, user.email, PASSWORD)).status).toBe(200);
      expect((await post("/api/auth/login", ADDRESS, { email: user.email, platform: "web" })).status).toBe(400);
      for (let i = 0; i < 3; i++) expect((await login(ADDRESS, `stuffing-${i}@example.com`, "wrong")).status).toBe(401);

      await expectRateLimited(await login(ADDRESS, user.email, PASSWORD));
      expect(await countOf("SELECT count(*) FROM sessions")).toBe(1);
      expect((await login(OTHER_ADDRESS, user.email, PASSWORD)).status).toBe(200);
    });

    it.each([
      {
        name: "failed logins reach the credential check",
        path: "/api/auth/login",
        bodies: Array.from({ length: 8 }, (_, i) => ({
          email: `burst-${i}@example.com`,
          password: "wrong",
          platform: "web",
        })),
        expected: { 401: 3, 429: 5 },
        rows: ["SELECT count(*) FROM login_attempts", 3],
      },
      {
        name: "reset requests with slow bodies get through",
        path: "/api/auth/password-reset/request",
        bodies: Array.from({ length: 5 }, () => ({ email: "person@example.com" })),
        expected: { 200: 2, 429: 3 },
        rows: ["SELECT count(*) FROM password_reset_tokens", 2],
      },
      {
        name: "token guesses reach the token check",
        path: "/api/auth/password-reset/consume",
        bodies: Array.from({ length: 6 }, (_, i) => ({ token: `not-a-token-${i}`, newPassword: NEW_PASSWORD })),
        expected: { 400: 2, 429: 4 },
        rows: null,
      },
    ] as const)(
      "lets at most the limit of a concurrent burst from one address through: $name",
      async ({ path, bodies, expected, rows }) => {
        await makeUser();
        expect(countStatuses(await postBurstWithHeldBodies(path, [...bodies]))).toEqual(expected);
        if (rows) expect(await countOf(rows[0])).toBe(rows[1]);
      },
    );

    it("answers a throttled login with 429 before reading an oversized body", async () => {
      for (let i = 0; i < 3; i++) expect((await login(ADDRESS, `stuffing-${i}@example.com`, "wrong")).status).toBe(401);
      const oversized = { email: "x@example.com", password: "p".repeat(128 * 1024), platform: "web" };
      await expectRateLimited(await post("/api/auth/login", ADDRESS, oversized));
      expect((await post("/api/auth/login", OTHER_ADDRESS, oversized)).status).toBe(413);
    });

    it("does not count a login that failed for a reason other than its credentials", async () => {
      // Refused connections make `login` throw an infrastructure error, not UnauthorizedError.
      const unreachablePool = new pg.Pool({ host: "127.0.0.1", port: 1, connectionTimeoutMillis: 1000 });
      const throttle = createClientIpThrottle({ limits: { login: { maxEvents: 1, windowSeconds: 900 } } });
      const broken = await listen(authListener(unreachablePool, { trustProxy: true, clientIpThrottle: throttle }));
      try {
        for (let i = 0; i < 3; i++) {
          const res = await createApi(() => broken.url).login(
            "person@example.com",
            { password: "wrong" },
            { "X-Forwarded-For": ADDRESS },
          );
          expect(res.status).toBe(500);
        }
        expect(throttle.retryAfterSeconds("login", ADDRESS)).toBeNull();
      } finally {
        await broken.close();
        await unreachablePool.end();
      }
    });

    it("refuses a password-reset request past the limit without creating a token, and answers alike below it", async () => {
      const user = await makeUser();
      const requestReset = (email: unknown) => post("/api/auth/password-reset/request", ADDRESS, { email });

      expect((await requestReset(undefined)).status).toBe(400);
      for (const email of [user.email, "nobody@example.com"]) {
        const res = await requestReset(email);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      }
      await expectRateLimited(await requestReset(user.email));
      expect(await countOf("SELECT count(*) FROM password_reset_tokens")).toBe(1);
      expect((await post("/api/auth/password-reset/request", OTHER_ADDRESS, { email: user.email })).status).toBe(200);
    });

    it("refuses consuming from an address after its invalid-token attempts, without consuming a valid token", async () => {
      const user = await makeUser();
      await post("/api/auth/password-reset/request", OTHER_ADDRESS, { email: user.email });
      const token = tokenFromResetUrl(mailer.sent.at(-1)?.resetUrl);
      const consume = (from: string, body: unknown) => post("/api/auth/password-reset/consume", from, body);

      expect((await consume(ADDRESS, { token, newPassword: "short" })).status).toBe(400);
      for (let i = 0; i < 2; i++)
        expect((await consume(ADDRESS, { token: `not-a-token-${i}`, newPassword: NEW_PASSWORD })).status).toBe(400);

      await expectRateLimited(await consume(ADDRESS, { token, newPassword: NEW_PASSWORD }));
      const pending = await pool.query<{ consumed_at: Date | null }>(
        "SELECT consumed_at FROM password_reset_tokens WHERE user_id = $1",
        [user.id],
      );
      expect(pending.rows).toEqual([{ consumed_at: null }]);
      expect((await consume(OTHER_ADDRESS, { token, newPassword: NEW_PASSWORD })).status).toBe(200);
    });
  });
});

describe("self person HTTP contract", () => {
  let runtime: Pool;
  let server: Listening;
  let tenantId: string;
  let token: string;
  let actorId: string;
  let peopleId: string;
  let ownId: string;
  let foreignId: string;
  const api = createApi(() => server.url);

  beforeAll(async () => {
    runtime = await createRuntimeRolePool(pool, "alldots_data");
    const runtimeRole = await runAsSystem("test:verify-runtime-role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(runtimeRole.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    tenantId = await createTestTenant(pool);
    const other = await createTestTenant(pool);
    const hash = await (passwordHash ??= hashPassword(PASSWORD));
    const user = await runAsSystem("self person test user", () =>
      createUser(pool, { tenantId, email: "self@example.com", passwordHash: hash }),
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
    server = await listen(authListener(runtime));
    token = await api.nativeToken("self@example.com");
  });

  afterEach(() => server.close());

  afterAll(async () => {
    await runtime.end();
  });

  const put = (body: unknown, authenticated = true) =>
    fetch(api.url("/api/auth/self-person"), {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(authenticated ? bearer(token) : {}) },
      body: JSON.stringify(body),
    });

  async function personId(): Promise<string | null> {
    const res = await api.session(bearer(token));
    expect(res.status).toBe(200);
    return z.object({ user: z.object({ personId: z.string().nullable() }) }).parse(await res.json()).user.personId;
  }

  const createPerson = () =>
    runInTenant(tenantId, () =>
      createChokePoint(runtime).createItem({ databaseId: peopleId, properties: { name: "Next" } }),
    );

  /** The settings singleton, with its selfPerson value linked so that changes to the edge attribute to it. */
  const linkedSingleton = () =>
    runInTenant(tenantId, async () => {
      const result = await runtime.query<{ id: string }>(
        `SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id
         WHERE d.owner_module_id = 'systemSettings' AND d.system = true AND i.deleted_at IS NULL`,
      );
      const id = result.rows.length === 1 ? result.rows[0]?.id : undefined;
      if (!id) throw new Error("Missing settings singleton");
      await withTransaction(runtime, (client) =>
        insertValueLink(client, { itemId: id, propertyKey: "selfPerson", ruleKey: "test", sources: [] }),
      );
      return id;
    });

  const selfPersonEdges = (where = "", params: unknown[] = []) =>
    runInTenant(tenantId, async () => {
      const { rows } = await runtime.query<{ item_b: string }>(
        `SELECT edge.item_b FROM item_relations edge JOIN relation_definitions rd ON rd.id = edge.relation_definition_id
         JOIN properties p ON p.id = rd.property_id_a WHERE p.key = 'selfPerson' ${where}`,
        params,
      );
      return rows;
    });

  async function withInvalidations(body: (events: InvalidationEvent[]) => Promise<void>): Promise<void> {
    const events: InvalidationEvent[] = [];
    setInvalidationHook((event) => events.push(event));
    try {
      await body(events);
    } finally {
      setInvalidationHook(() => {});
    }
  }

  const itemEvents = (events: InvalidationEvent[], itemId: string) =>
    events.filter((event) => event.scope === "item" && event.itemId === itemId);

  it("sets, replaces and clears the link, returning it through the session", async () => {
    expect(await personId()).toBeNull();
    const first = await put({ personId: ownId });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ personId: ownId });
    expect(await personId()).toBe(ownId);
    const next = await createPerson();
    expect((await put({ personId: next.id })).status).toBe(200);
    expect(await personId()).toBe(next.id);
    expect((await put({ personId: null })).status).toBe(200);
    expect(await personId()).toBeNull();
  });

  it("attributes a linked self-person change to the authenticated user", async () => {
    const singletonId = await linkedSingleton();
    await withInvalidations(async (events) => {
      expect((await put({ personId: ownId })).status).toBe(200);
      expect(itemEvents(events, singletonId)).toEqual([expect.objectContaining({ userId: actorId })]);
    });
  });

  it("attributes removal of an existing linked self-person edge to the authenticated user", async () => {
    expect((await put({ personId: ownId })).status).toBe(200);
    const singletonId = await linkedSingleton();
    await withInvalidations(async (events) => {
      expect((await put({ personId: null })).status).toBe(200);
      expect(await personId()).toBeNull();
      expect(await selfPersonEdges("AND edge.item_a = $1 AND edge.item_b = $2", [singletonId, ownId])).toEqual([]);
      const links = await runInTenant(tenantId, () => createChokePoint(runtime).getValueLinksForItems([singletonId]));
      expect(links.get(singletonId)?.selfPerson).toMatchObject({ valueKind: "inheritedBroken", brokenBy: "user" });
      expect(itemEvents(events, singletonId)).toEqual([expect.objectContaining({ userId: actorId })]);
      events.length = 0;
      expect((await put({ personId: null })).status).toBe(200);
      expect(events).toEqual([]);
    });
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

  it("returns identical 404 bodies for foreign, unknown and non-People ids, preserving the previous link", async () => {
    expect((await put({ personId: ownId })).status).toBe(200);
    const event = await runInTenant(tenantId, async () => {
      const db = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "events"));
      if (!db) throw new Error("Events missing");
      return createChokePoint(runtime).createItem({
        databaseId: db.id,
        properties: { name: "Event", date: "2026-10-22" },
      });
    });
    const missing = await put({ personId: randomUUID() });
    expect(missing.status).toBe(404);
    const missingBody: unknown = await missing.json();
    for (const id of [foreignId, event.id]) {
      const res = await put({ personId: id });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(missingBody);
    }
    expect(await personId()).toBe(ownId);
  });

  it("serializes concurrent replacements so exactly one edge remains", async () => {
    const next = await createPerson();
    const results = await Promise.all([put({ personId: ownId }), put({ personId: next.id })]);
    expect(results.map((res) => res.status)).toEqual([200, 200]);
    expect([ownId, next.id]).toContain(await personId());
    expect(await selfPersonEdges()).toHaveLength(1);
  });

  it("requires authentication and validates personId before writing", async () => {
    expect((await put({ personId: ownId }, false)).status).toBe(401);
    for (const body of [{}, null, [], { personId: 1 }, { personId: "bad" }]) expect((await put(body)).status).toBe(400);
    expect(await personId()).toBeNull();
  });
});

describe("POST /api/auth/sessions/revoke-others", () => {
  let server: Listening;
  const api = createApi(() => server.url);

  beforeEach(async () => {
    await resetDatabase(pool);
    wireRealtimeHooks(pool);
    server = await listen(authListener(pool), await createSyncUpgradeHandler(pool));
  });

  afterEach(() => server.close());

  const revokeOthers = (token?: string) =>
    fetch(api.url("/api/auth/sessions/revoke-others"), { method: "POST", headers: token ? bearer(token) : {} });

  it("keeps only the calling session: 200 with the count, 401 for the others, their pushes revoked and both other sockets closed with 4401 after the commit", async () => {
    const user = await makeUser("caller@example.com");
    const caller = await api.signIn(user.email);
    const others = [await api.signIn(user.email), await api.signIn(user.email)];
    await registration(user.id, caller.sessionId, "webPush");
    const otherRegistrations: string[] = [];
    for (const other of others) otherRegistrations.push(await registration(user.id, other.sessionId, "webPush"));

    await withSockets(server.url, async (open) => {
      const callerSocket = await open(caller);
      const otherSockets = [await open(others[0]!), await open(others[1]!)];

      const res = await revokeOthers(caller.token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revokedCount: 2 });
      for (const other of otherSockets) {
        // The session already reads as revoked when the close arrives: the close follows the commit.
        expect(await within(other.closed, 10_000, "A revoked session's socket close")).toEqual({
          code: 4401,
          sessionActive: false,
        });
      }
      expect(await api.sessionStatus(caller.token)).toBe(200);
      for (const other of others) expect(await api.sessionStatus(other.token)).toBe(401);
      expect(await revokedRegistrations(user.id)).toEqual(otherRegistrations.sort());
      expect(await isSessionActive(pool, caller.sessionId)).toBe(true);
      expect(callerSocket.socket.readyState).toBe(WebSocket.OPEN);
    });
  });

  it("never revokes another user's sessions, and answers 0 when the caller has no other session", async () => {
    const owner = await makeUser("owner@example.com");
    const caller = await makeUser("single@example.com");
    const ownerSessions = [await api.signIn(owner.email), await api.signIn(owner.email)];
    const only = await api.signIn(caller.email);

    const res = await revokeOthers(only.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revokedCount: 0 });
    expect(await api.sessionStatus(only.token)).toBe(200);
    for (const session of ownerSessions) expect(await api.sessionStatus(session.token)).toBe(200);
  });

  it("refuses an unauthenticated call with 401 and revokes nothing", async () => {
    const session = await api.signIn((await makeUser("victim@example.com")).email);
    expect((await revokeOthers()).status).toBe(401);
    expect(await api.sessionStatus(session.token)).toBe(200);
  });

  it("is matched apart from the single-session revoke route", async () => {
    const user = await makeUser("router@example.com");
    const caller = await api.signIn(user.email);
    const other = await api.signIn(user.email);
    // `revoke-others` as a session id goes to the single revoke route, which refuses it as no UUID.
    const single = await fetch(api.url("/api/auth/sessions/revoke-others/revoke"), {
      method: "POST",
      headers: bearer(caller.token),
    });
    expect(single.status).toBe(400);
    expect(await api.sessionStatus(other.token)).toBe(200);
  });
});

describe("POST /api/auth/login replacing the sessions of its installation", () => {
  // The auth listener, realtime hooks and sync upgrade share one pool as `alldots_data`, the API's role; fixtures go
  // through the superuser `pool`.
  let runtime: Pool;
  let server: Listening;
  const api = createApi(() => server.url);
  const sessionsBody = z.object({ sessions: z.array(z.object({ id: z.string(), deviceName: z.string().nullable() })) });

  beforeAll(async () => {
    runtime = await createRuntimeRolePool(pool, "alldots_data");
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    wireRealtimeHooks(runtime);
    server = await listen(authListener(runtime), await createSyncUpgradeHandler(runtime));
  });

  afterEach(() => server.close());

  afterAll(async () => {
    // The hooks are module-global; leave none bound to the ended pool.
    setInvalidationHook(() => {});
    setDocUpdateHook(() => {});
    setNotificationCreatedHook(() => {});
    setNotificationReadStateHook(() => {});
    setSessionRevokedHook(() => {});
    setSempThreadInvalidationHook(() => {});
    setAgentRunEventHook(() => {});
    await runtime.end();
  });

  async function listedSessions(token: string): Promise<Array<{ id: string; deviceName: string | null }>> {
    const res = await fetch(api.url("/api/auth/sessions"), { headers: bearer(token) });
    expect(res.status).toBe(200);
    return sessionsBody.parse(await res.json()).sessions;
  }

  it("answers the replaced token with 401, revokes its push registrations and closes its socket with 4401 after the commit, while the new token works", async () => {
    const user = await makeUser("caller@example.com");
    const otherDevice = await api.signIn(user.email, { deviceId: OTHER_DEVICE_ID });
    const previous = await api.signIn(user.email, { deviceId: DEVICE_ID });
    const previousRegistration = await registration(user.id, previous.sessionId);
    await registration(user.id, otherDevice.sessionId);

    await withSockets(server.url, async (open) => {
      const otherDeviceSocket = await open(otherDevice);
      const previousSocket = await open(previous);

      const next = await api.signIn(user.email, { deviceId: DEVICE_ID });

      // The session is no longer active when the close arrives: the close follows the commit.
      expect(await within(previousSocket.closed, 10_000, "The replaced session's socket close")).toEqual({
        code: 4401,
        sessionActive: false,
      });
      expect(await api.sessionStatus(previous.token)).toBe(401);
      expect(await api.sessionStatus(next.token)).toBe(200);
      expect(await api.sessionStatus(otherDevice.token)).toBe(200);
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
    const first = await api.signIn(user.email, { deviceId: DEVICE_ID });
    await registration(user.id, first.sessionId);

    expect((await api.login(user.email, { platform: "ios", ...fields })).status).toBe(200);
    expect(await api.sessionStatus(first.token)).toBe(200);
    expect(await revokedRegistrations(user.id)).toEqual([]);
    expect(await listedSessions(first.token)).toHaveLength(2);
  });

  it("leaves another user's session with the same deviceId alone, in both directions", async () => {
    const owner = await makeUser("owner@example.com");
    const other = await makeUser("other@example.com");
    const ownerSession = await api.signIn(owner.email, { deviceId: DEVICE_ID });
    await registration(owner.id, ownerSession.sessionId);

    const otherSession = await api.signIn(other.email, { deviceId: DEVICE_ID });
    expect(await api.sessionStatus(ownerSession.token)).toBe(200);
    expect(await revokedRegistrations(owner.id)).toEqual([]);

    const ownerNext = await api.signIn(owner.email, { deviceId: DEVICE_ID });
    expect(await api.sessionStatus(ownerSession.token)).toBe(401);
    expect(await api.sessionStatus(ownerNext.token)).toBe(200);
    expect(await api.sessionStatus(otherSession.token)).toBe(200);
  });

  // The schedule failing without the installation lock is forced in authActions.test.ts; this case sends the logins
  // at once through the composed route under the API's role.
  it("ends simultaneous logins with one deviceId with exactly one active session of that installation", async () => {
    const user = await makeUser("caller@example.com");
    const previous = await api.signIn(user.email, { deviceId: DEVICE_ID });
    const otherDevice = await api.signIn(user.email, { deviceId: OTHER_DEVICE_ID });

    const tokens = await Promise.all(
      Array.from({ length: 4 }, () => api.nativeToken(user.email, { deviceId: DEVICE_ID, deviceName: "Phone" })),
    );
    const statuses = await Promise.all(tokens.map((token) => api.sessionStatus(token)));
    expect(statuses.sort()).toEqual([200, 401, 401, 401]);
    expect(await api.sessionStatus(previous.token)).toBe(401);
    const listed = await listedSessions(otherDevice.token);
    expect(listed.filter((session) => session.deviceName === "Phone")).toHaveLength(1);
    expect(listed).toHaveLength(2);
  });

  it("revokes nothing on a login rejected for a wrong password or by the lockout", async () => {
    const user = await makeUser("caller@example.com");
    const first = await api.signIn(user.email, { deviceId: DEVICE_ID });
    await registration(user.id, first.sessionId);

    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      const wrong = await api.login(user.email, { platform: "ios", deviceId: DEVICE_ID, password: "wrong-password" });
      expect(wrong.status).toBe(401);
      expect(await api.sessionStatus(first.token)).toBe(200);
    }
    expect((await api.login(user.email, { platform: "ios", deviceId: DEVICE_ID })).status).toBe(401);
    expect(await api.sessionStatus(first.token)).toBe(200);
    expect(await revokedRegistrations(user.id)).toEqual([]);
    expect(await listedSessions(first.token)).toHaveLength(1);
  });

  it("lists one entry per deviceId through GET /api/auth/sessions after repeated logins", async () => {
    const user = await makeUser("caller@example.com");
    for (let i = 0; i < 3; i++) await api.signIn(user.email, { deviceId: DEVICE_ID, deviceName: "Phone" });
    const phone = await api.signIn(user.email, { deviceId: DEVICE_ID, deviceName: "Phone" });
    await api.signIn(user.email, { deviceId: OTHER_DEVICE_ID, deviceName: "Tablet" });
    const tablet = await api.signIn(user.email, { deviceId: OTHER_DEVICE_ID, deviceName: "Tablet" });

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

describe("POST /api/auth/password-change", () => {
  // The auth listener runs on a pool as `alldots_data`, the API's role; fixtures go through the superuser `pool`.
  let runtime: Pool;
  let server: Listening;
  let mailer: FakeMailer;
  const api = createApi(() => server.url);
  const from = (address: string) => ({ "X-Forwarded-For": address });

  beforeAll(async () => {
    runtime = await createRuntimeRolePool(pool, "alldots_data");
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    mailer = createFakeMailer();
    server = await listen(authListener(runtime, { passwordResetMailer: mailer, trustProxy: true }));
  });

  afterEach(() => server.close());

  afterAll(async () => {
    await runtime.end();
  });

  const login = (email: string, password: string, address = ADDRESS) =>
    api.login(email, { password, platform: "ios" }, from(address));
  const signIn = (email: string) => api.signIn(email, {}, from(ADDRESS));
  const postChange = (token: string | null, body: unknown, address = ADDRESS) =>
    api.post("/api/auth/password-change", body, { ...from(address), ...(token === null ? {} : bearer(token)) });
  const change = (token: string, address?: string) =>
    postChange(token, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, address);

  async function passwordHashOf(userId: string): Promise<string> {
    const { rows } = await pool.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [
      userId,
    ]);
    if (!rows[0]) throw new Error("user not found");
    return rows[0].password_hash;
  }

  async function failedAttempts(email: string): Promise<string[]> {
    const { rows } = await pool.query<{ ip: string }>(
      "SELECT host(ip) AS ip FROM login_attempts WHERE email = $1 AND succeeded = false ORDER BY attempted_at, id",
      [email],
    );
    return rows.map((row) => row.ip);
  }

  /** A caller signed in once, with its password hash before the case. */
  async function caller() {
    const user = await makeUser("caller@example.com");
    const calling = await signIn(user.email);
    return { user, calling, hashBefore: await passwordHashOf(user.id) };
  }

  async function expectReauthenticationFailed(res: Response): Promise<void> {
    expect(res.status).toBe(403);
    expect(errorBody.parse(await res.json()).code).toBe("reauthentication_failed");
  }

  it("answers 200, lets the new password log in and not the old one, keeps the calling token and revokes every other session with its push registrations", async () => {
    const user = await makeUser("caller@example.com");
    const bystander = await makeUser("bystander@example.com");
    const bystanderSession = await signIn(bystander.email);
    const calling = await signIn(user.email);
    const others = [await signIn(user.email), await signIn(user.email)];
    await registration(user.id, calling.sessionId);
    const otherRegistrations: string[] = [];
    for (const other of others) otherRegistrations.push(await registration(user.id, other.sessionId));

    const res = await change(calling.token);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await login(user.email, PASSWORD)).status).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
    expect(await api.sessionStatus(calling.token)).toBe(200);
    for (const other of others) expect(await api.sessionStatus(other.token)).toBe(401);
    expect(await revokedRegistrations(user.id)).toEqual(otherRegistrations.sort());
    expect(await api.sessionStatus(bystanderSession.token)).toBe(200);
    expect((await login(bystander.email, PASSWORD)).status).toBe(200);
  });

  it("answers a wrong currentPassword with 403 reauthentication_failed, records a failed attempt for the caller's address and keeps the calling token and the password", async () => {
    const { user, calling } = await caller();
    const second = await signIn(user.email);

    await expectReauthenticationFailed(
      await postChange(calling.token, { currentPassword: "wrong-password", newPassword: NEW_PASSWORD }),
    );
    expect(await failedAttempts(user.email)).toEqual([ADDRESS]);
    expect(await api.sessionStatus(calling.token)).toBe(200);
    expect(await api.sessionStatus(second.token)).toBe(200);
    expect((await login(user.email, NEW_PASSWORD, OTHER_ADDRESS)).status).toBe(401);
    expect((await login(user.email, PASSWORD, OTHER_ADDRESS)).status).toBe(200);
  });

  it("answers 403 reauthentication_failed to the correct currentPassword while failed logins lock the address out, and 200 from another address", async () => {
    const { user, calling, hashBefore } = await caller();
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) expect((await login(user.email, "wrong-password")).status).toBe(401);

    await expectReauthenticationFailed(await change(calling.token));
    expect(await passwordHashOf(user.id)).toBe(hashBefore);
    expect(await failedAttempts(user.email)).toEqual(Array.from({ length: LOCKOUT_THRESHOLD + 1 }, () => ADDRESS));
    expect(await api.sessionStatus(calling.token)).toBe(200);

    expect((await change(calling.token, OTHER_ADDRESS)).status).toBe(200);
    expect(await passwordHashOf(user.id)).not.toBe(hashBefore);
  });

  it("locks login out of the address after LOCKOUT_THRESHOLD wrong currentPasswords", async () => {
    const { user, calling } = await caller();
    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      const res = await postChange(calling.token, { currentPassword: "wrong-password", newPassword: NEW_PASSWORD });
      expect(res.status).toBe(403);
    }
    expect((await login(user.email, PASSWORD)).status).toBe(401);
    expect((await login(user.email, PASSWORD, OTHER_ADDRESS)).status).toBe(200);
    expect(await api.sessionStatus(calling.token)).toBe(200);
  });

  it("records the failed attempt for the socket peer, not for X-Forwarded-For, on a listener that does not trust the proxy", async () => {
    const { user, calling } = await caller();
    const untrusting = await listen(authListener(runtime, { passwordResetMailer: mailer }));
    try {
      const res = await createApi(() => untrusting.url).post(
        "/api/auth/password-change",
        { currentPassword: "wrong-password", newPassword: NEW_PASSWORD },
        { ...from(ADDRESS), ...bearer(calling.token) },
      );
      expect(res.status).toBe(403);
      expect(await failedAttempts(user.email)).toEqual(["127.0.0.1"]);
    } finally {
      await untrusting.close();
    }
  });

  it("answers 400 password_reset_token_consumed to a reset link that was requested before the change", async () => {
    const { user, calling } = await caller();
    expect((await api.post("/api/auth/password-reset/request", { email: user.email })).status).toBe(200);
    const token = tokenFromResetUrl(mailer.sent.at(-1)?.resetUrl);
    expect((await change(calling.token)).status).toBe(200);

    const consumed = await api.post("/api/auth/password-reset/consume", { token, newPassword: "from-the-old-link" });
    expect(consumed.status).toBe(400);
    expect(errorBody.parse(await consumed.json()).code).toBe("password_reset_token_consumed");
    expect((await login(user.email, "from-the-old-link")).status).toBe(401);
    expect((await login(user.email, NEW_PASSWORD)).status).toBe(200);
  });

  it.each<[string, unknown, string | undefined]>([
    ["a newPassword of 7 characters", { currentPassword: PASSWORD, newPassword: "1234567" }, "newPassword"],
    ["an empty newPassword", { currentPassword: PASSWORD, newPassword: "" }, "newPassword"],
    ["a missing newPassword", { currentPassword: PASSWORD }, "newPassword"],
    ["a non-string newPassword", { currentPassword: PASSWORD, newPassword: 12345678 }, "newPassword"],
    ["a missing currentPassword", { newPassword: NEW_PASSWORD }, "currentPassword"],
    ["a non-string currentPassword", { currentPassword: 12345678, newPassword: NEW_PASSWORD }, "currentPassword"],
    ["an empty currentPassword", { currentPassword: "", newPassword: NEW_PASSWORD }, "currentPassword"],
    ["the JSON literal null", "null", undefined],
    ["a JSON array", "[]", undefined],
    ["malformed JSON", "{", undefined],
  ])("answers %s with 400 validation_failed, records no attempt and changes nothing", async (_name, body, field) => {
    const { user, calling, hashBefore } = await caller();

    const res = await postChange(calling.token, body);

    expect(res.status).toBe(400);
    const error = errorBody.parse(await res.json());
    expect(error.code).toBe("validation_failed");
    if (field) expect(error.details).toEqual({ field });
    expect(await failedAttempts(user.email)).toEqual([]);
    expect(await passwordHashOf(user.id)).toBe(hashBefore);
    expect(await api.sessionStatus(calling.token)).toBe(200);
  });

  it("answers 413 to a body over the 64 KiB cap and changes nothing", async () => {
    const { user, calling, hashBefore } = await caller();
    const res = await postChange(calling.token, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      padding: "x".repeat(64 * 1024),
    });
    expect(res.status).toBe(413);
    expect(await passwordHashOf(user.id)).toBe(hashBefore);
    expect(await failedAttempts(user.email)).toEqual([]);
  });

  it("refuses an unauthenticated call with 401 before reading the body, and answers 404 to another method", async () => {
    const { user, calling, hashBefore } = await caller();
    expect((await postChange(null, "{")).status).toBe(401);
    expect(await passwordHashOf(user.id)).toBe(hashBefore);
    expect(await failedAttempts(user.email)).toEqual([]);
    expect(await api.sessionStatus(calling.token)).toBe(200);
    expect((await fetch(api.url("/api/auth/password-change"), { headers: bearer(calling.token) })).status).toBe(404);
  });

  it("answers two simultaneous changes with the same currentPassword with one 200 and one 403", async () => {
    const user = await makeUser("caller@example.com");
    const callers = [
      { session: await signIn(user.email), newPassword: "first-new-password" },
      { session: await signIn(user.email), newPassword: "second-new-password" },
    ];

    const responses = await Promise.all(
      callers.map((entry) =>
        postChange(entry.session.token, { currentPassword: PASSWORD, newPassword: entry.newPassword }),
      ),
    );

    const statuses = responses.map((res) => res.status);
    expect([...statuses].sort()).toEqual([200, 403]);
    const refused = responses.find((res) => res.status === 403);
    const winner = callers[statuses.indexOf(200)];
    const loser = callers[statuses.indexOf(403)];
    if (!refused || !winner || !loser) throw new Error("expected one accepted and one refused change");
    await expectReauthenticationFailed(refused);
    expect((await login(user.email, winner.newPassword, OTHER_ADDRESS)).status).toBe(200);
    expect((await login(user.email, loser.newPassword, OTHER_ADDRESS)).status).toBe(401);
    expect(await api.sessionStatus(winner.session.token)).toBe(200);
    expect(await api.sessionStatus(loser.session.token)).toBe(401);
  });

  it("answers 401 and writes no new hash when a suspension of the caller's account commits while the request is in flight", async () => {
    const admin = await makeUser("admin@example.com", "admin");
    const { user, calling, hashBefore } = await caller();
    let releaseSuspension!: () => void;
    const suspensionHeld = new Promise<void>((resolve) => (releaseSuspension = resolve));
    let markSuspended!: () => void;
    const suspendedUncommitted = new Promise<void>((resolve) => (markSuspended = resolve));
    const suspension = withTransaction(pool, async (client) => {
      await suspendAccount(client, { actorUserId: admin.id, targetUserId: user.id });
      markSuspended();
      await suspensionHeld;
    });
    // Observed here too, so an early failure is never an unhandled rejection.
    suspension.catch(() => undefined);
    await Promise.race([suspendedUncommitted, suspension]);

    // The uncommitted suspension leaves the tenant active, so the request reads it and then waits.
    const responding = change(calling.token);
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
    expect(await api.sessionStatus(calling.token)).toBe(401);
  });
});
