import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { getTenantZeroId, getTestPool, resetDatabase, tenantForNextTestUser } from "../testSupport/testDb.js";
import { hashPassword } from "../auth/passwordHash.js";
import { createUser } from "../auth/usersStore.js";
import {
  getActiveSessionByTokenHash,
  isSessionActive,
  listActiveSessionsForUser,
  listSessionsForUser,
} from "../auth/sessionsStore.js";
import { setSessionRevokedHook, type SessionRevokedEvent } from "../realtimeHook.js";
import { countRecentFailedAttempts } from "../auth/loginAttemptsStore.js";
import { transitionTenantStatus } from "../tenancy/tenantsStore.js";
import { withTransaction } from "../db/pool.js";
import { createRuntimeRolePool, createTestTenant } from "../testSupport/tenantFixtures.js";
import { suspendAccount } from "../tenancy/accountsAdminStore.js";
import {
  login,
  verifySessionToken,
  logout,
  revokeUserSession,
  revokeOtherUserSessions,
  bootstrapFirstAccount,
  type LoginDevice,
  type LoginResult,
} from "../auth/authActions.js";
import {
  listPushSubscriptionsForUser,
  upsertApnsSubscription,
  upsertWebPushSubscription,
} from "../push/pushSubscriptionsStore.js";
import { SESSION_IDLE_TTL_SECONDS_BY_PLATFORM, SESSION_MAX_LIFETIME_SECONDS } from "../auth/authActions.js";
import { LOCKOUT_THRESHOLD } from "../auth/loginLockout.js";
import { SESSION_DEVICE_LOCK_CLASS } from "../auth/sessionDeviceLock.js";
import { NotFoundError, UnauthorizedError, ValidationError } from "../errors.js";

let pool: Pool;

async function makeUser(email = "person@example.com", password = "s3cret-password") {
  return createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email,
    passwordHash: await hashPassword(password),
  });
}

describe("auth actions (issue #140)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("active session listing", () => {
    it("filters by owner, expiry and revocation and sorts by last activity", async () => {
      const user = await makeUser();
      const other = await makeUser("other@example.com");
      const signIn = (email: string) =>
        login(pool, { email, password: "s3cret-password", platform: "web", ip: "127.0.0.1" });
      const [first, second, revoked, expired, foreign] = await Promise.all([
        signIn(user.email),
        signIn(user.email),
        signIn(user.email),
        signIn(user.email),
        signIn(other.email),
      ]);
      await pool.query("UPDATE sessions SET last_seen_at = now() - interval '1 hour' WHERE id = $1", [
        first.session.id,
      ]);
      await pool.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [revoked.session.id]);
      await pool.query("UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1", [
        expired.session.id,
      ]);
      expect((await listActiveSessionsForUser(pool, user.id)).map((session) => session.id)).toEqual([
        second.session.id,
        first.session.id,
      ]);
      expect((await listActiveSessionsForUser(pool, other.id)).map((session) => session.id)).toEqual([
        foreign.session.id,
      ]);
    });
  });

  describe("login", () => {
    it("creates a session and returns an opaque token that later verifies", async () => {
      const user = await makeUser();

      const result = await login(pool, {
        email: user.email,
        password: "s3cret-password",
        platform: "web",
        ip: "127.0.0.1",
      });

      expect(result.user).toEqual({
        id: user.id,
        email: user.email,
        displayName: null,
        locale: user.locale,
        createdAt: user.createdAt,
      });
      expect(result.role).toBe("member");
      expect(result.token).toBeTruthy();
      expect((result.user as { passwordHash?: unknown }).passwordHash).toBeUndefined();

      const identity = await verifySessionToken(pool, result.token);
      expect(identity.user.id).toBe(user.id);
      expect(identity.session.id).toBe(result.session.id);
    });

    it("persists the device passed to login, and leaves the device columns NULL without one", async () => {
      const user = await makeUser();
      const device = {
        deviceId: "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f",
        deviceName: "iPad Air",
        deviceKind: "ipad",
        osVersion: "26.0",
        appVersion: "2.0.0",
      } as const;

      const withDevice = await login(pool, {
        email: user.email,
        password: "s3cret-password",
        platform: "ios",
        ip: "127.0.0.1",
        device,
      });
      expect(withDevice.session).toMatchObject(device);

      const without = await login(pool, {
        email: user.email,
        password: "s3cret-password",
        platform: "ios",
        ip: "127.0.0.1",
      });
      expect(without.session).toMatchObject({
        deviceId: null,
        deviceName: null,
        deviceKind: null,
        osVersion: null,
        appVersion: null,
      });
    });

    it("records a successful attempt", async () => {
      const user = await makeUser();
      await login(pool, { email: user.email, password: "s3cret-password", platform: "web", ip: "1.2.3.4" });
      expect(await countRecentFailedAttempts(pool, user.email, "1.2.3.4", 3600)).toBe(0);
    });

    it("rejects a wrong password with the generic UnauthorizedError and records a failed attempt", async () => {
      const user = await makeUser();
      await expect(
        login(pool, { email: user.email, password: "wrong-password", platform: "web", ip: "1.2.3.4" }),
      ).rejects.toThrow(UnauthorizedError);
      expect(await countRecentFailedAttempts(pool, user.email, "1.2.3.4", 3600)).toBe(1);
    });

    it("rejects an unknown email with the same UnauthorizedError, and still records the attempt", async () => {
      await expect(
        login(pool, { email: "nobody@example.com", password: "anything", platform: "web", ip: "1.2.3.4" }),
      ).rejects.toThrow(UnauthorizedError);
      expect(await countRecentFailedAttempts(pool, "nobody@example.com", "1.2.3.4", 3600)).toBe(1);
    });

    it("creates one independent session per login, not one shared session", async () => {
      const user = await makeUser();
      const first = await login(pool, {
        email: user.email,
        password: "s3cret-password",
        platform: "web",
        ip: "1.1.1.1",
      });
      const second = await login(pool, {
        email: user.email,
        password: "s3cret-password",
        platform: "ios",
        ip: "1.1.1.1",
      });

      expect(first.session.id).not.toBe(second.session.id);
      const sessions = await listSessionsForUser(pool, user.id);
      expect(sessions).toHaveLength(2);
    });
  });

  describe("display name and role (issue #1387)", () => {
    it("createUser returns a null displayName for an account created without one", async () => {
      const user = await makeUser();
      expect(user.displayName).toBeNull();
    });

    it("login and verifySessionToken return the displayName stored on the account", async () => {
      const user = await makeUser();
      // Nothing writes the name yet (#1513 does, at account creation), so the test sets the column directly.
      await pool.query("UPDATE users SET display_name = $2 WHERE id = $1", [user.id, "Ada Lovelace"]);

      const result = await login(pool, {
        email: user.email,
        password: "s3cret-password",
        platform: "web",
        ip: "1.2.3.4",
      });
      expect(result.user.displayName).toBe("Ada Lovelace");

      const identity = await verifySessionToken(pool, result.token);
      expect(identity.user.displayName).toBe("Ada Lovelace");
    });

    it("login returns the role of the account, admin or member", async () => {
      const admin = await createUser(pool, {
        tenantId: await tenantForNextTestUser(pool),
        email: "admin@example.com",
        passwordHash: await hashPassword("s3cret-password"),
        role: "admin",
      });
      const member = await makeUser("member@example.com");

      const adminLogin = await login(pool, {
        email: admin.email,
        password: "s3cret-password",
        platform: "web",
        ip: "1.2.3.4",
      });
      const memberLogin = await login(pool, {
        email: member.email,
        password: "s3cret-password",
        platform: "web",
        ip: "1.2.3.4",
      });

      expect(adminLogin.role).toBe("admin");
      expect(memberLogin.role).toBe("member");
    });
  });

  describe("lockout (issue #232)", () => {
    async function failLogin(email: string, ip: string) {
      await expect(login(pool, { email, password: "wrong-password", platform: "web", ip })).rejects.toThrow(
        UnauthorizedError,
      );
    }

    /** Pushes every recorded attempt for this email+IP pair back by `seconds`, simulating the lockout window elapsing without a real-time sleep in the test. */
    async function backdateAttempts(email: string, ip: string, seconds: number) {
      await pool.query(
        `UPDATE login_attempts SET attempted_at = attempted_at - make_interval(secs => $3) WHERE email = $1 AND ip = $2`,
        [email, ip, seconds],
      );
    }

    it("records every attempt with a normalized (trimmed, lowercased) email", async () => {
      await makeUser("person@example.com");
      await login(pool, { email: " Person@Example.com ", password: "s3cret-password", platform: "web", ip: "5.5.5.5" });
      expect(await countRecentFailedAttempts(pool, "person@example.com", "5.5.5.5", 3600)).toBe(0);

      const { rows } = await pool.query<{ email: string }>(
        "SELECT email FROM login_attempts WHERE ip = '5.5.5.5' ORDER BY attempted_at DESC LIMIT 1",
      );
      expect(rows[0]!.email).toBe("person@example.com");
    });

    it("rejects a correct password once the threshold of consecutive failures is reached", async () => {
      const user = await makeUser();
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await failLogin(user.email, "6.6.6.6");
      }

      await expect(
        login(pool, { email: user.email, password: "s3cret-password", platform: "web", ip: "6.6.6.6" }),
      ).rejects.toThrow(UnauthorizedError);
    });

    it("does not lock out below the threshold", async () => {
      const user = await makeUser();
      for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
        await failLogin(user.email, "7.7.7.7");
      }

      const result = await login(pool, {
        email: user.email,
        password: "s3cret-password",
        platform: "web",
        ip: "7.7.7.7",
      });
      expect(result.token).toBeTruthy();
    });

    it("scopes lockout to the email+IP pair, not the email alone", async () => {
      const user = await makeUser();
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await failLogin(user.email, "8.8.8.8");
      }

      const result = await login(pool, {
        email: user.email,
        password: "s3cret-password",
        platform: "web",
        ip: "9.9.9.9",
      });
      expect(result.token).toBeTruthy();
    });

    it("grows the lockout window exponentially with further failures through it", async () => {
      const user = await makeUser();
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await failLogin(user.email, "10.10.10.10");
      }
      // First lockout window is LOCKOUT_BASE_SECONDS (30s); back past it but the rejected
      // retry below is itself recorded as a new failure, doubling the next window to 60s.
      await backdateAttempts(user.email, "10.10.10.10", 31);
      await failLogin(user.email, "10.10.10.10");

      // Only 35s elapsed since that failure — inside the doubled ~60s window, so still locked.
      await backdateAttempts(user.email, "10.10.10.10", 35);
      await expect(
        login(pool, { email: user.email, password: "s3cret-password", platform: "web", ip: "10.10.10.10" }),
      ).rejects.toThrow(UnauthorizedError);
    });

    it("resets the active failure sequence after a success, so lockout starts fresh", async () => {
      const user = await makeUser();
      for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
        await failLogin(user.email, "11.11.11.11");
      }
      const result = await login(pool, {
        email: user.email,
        password: "s3cret-password",
        platform: "web",
        ip: "11.11.11.11",
      });
      expect(result.token).toBeTruthy();

      for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
        await failLogin(user.email, "11.11.11.11");
      }
      const secondResult = await login(pool, {
        email: user.email,
        password: "s3cret-password",
        platform: "web",
        ip: "11.11.11.11",
      });
      expect(secondResult.token).toBeTruthy();
    });

    it("lifts once the lockout window has elapsed", async () => {
      const user = await makeUser();
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await failLogin(user.email, "12.12.12.12");
      }
      await backdateAttempts(user.email, "12.12.12.12", 31);

      const result = await login(pool, {
        email: user.email,
        password: "s3cret-password",
        platform: "web",
        ip: "12.12.12.12",
      });
      expect(result.token).toBeTruthy();
    });
  });

  describe("verifySessionToken", () => {
    it("rejects a garbage token", async () => {
      await expect(verifySessionToken(pool, "not-a-real-token")).rejects.toThrow(UnauthorizedError);
    });

    it("updates last_seen_at on success", async () => {
      const user = await makeUser();
      const { token, session } = await login(pool, {
        email: user.email,
        password: "s3cret-password",
        platform: "web",
        ip: "1.1.1.1",
      });

      const before = session.lastSeenAt;
      await new Promise((resolve) => setTimeout(resolve, 10));
      await verifySessionToken(pool, token);

      const active = await getActiveSessionByTokenHash(pool, session.tokenHash);
      expect(active?.lastSeenAt).not.toBe(before);
    });
  });

  describe("sliding session expiry (issue #1512)", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    async function loginAs(platform: "web" | "ios" | "macos") {
      const user = await makeUser(`${platform}-slide@example.com`);
      return login(pool, { email: user.email, password: "s3cret-password", platform, ip: "1.1.1.1" });
    }

    // Raw SQL: production cannot age a session, and the test needs created_at/expires_at in the past.
    async function setTimes(id: string, createdDaysAgo: number, expiresInDays: number): Promise<void> {
      await withTransaction(pool, (client) =>
        client.query(
          `UPDATE sessions SET created_at = now() - make_interval(days => $2::int),
                               expires_at = now() + make_interval(days => $3::int) WHERE id = $1`,
          [id, createdDaysAgo, expiresInDays],
        ),
      );
    }

    async function expiresAtMs(id: string): Promise<number> {
      const { rows } = await pool.query<{ expires_at: Date }>(`SELECT expires_at FROM sessions WHERE id = $1`, [id]);
      return rows[0]!.expires_at.getTime();
    }

    it.each([
      ["ios", 90],
      ["macos", 90],
      ["web", 30],
    ] as const)("pushes a %s session expiry to about %i days ahead", async (platform, days) => {
      const { token, session } = await loginAs(platform);
      expect(SESSION_IDLE_TTL_SECONDS_BY_PLATFORM[platform]).toBe(days * 86400);
      await setTimes(session.id, 0, 1);

      await verifySessionToken(pool, token);

      const delta = (await expiresAtMs(session.id)) - Date.now();
      expect(Math.abs(delta - days * DAY_MS)).toBeLessThan(60_000);
    });

    it("sets the initial expiry from the platform idle window", async () => {
      const ios = await loginAs("ios");
      const web = await loginAs("web");
      expect(Math.abs(Date.parse(ios.session.expiresAt) - Date.now() - 90 * DAY_MS)).toBeLessThan(60_000);
      expect(Math.abs(Date.parse(web.session.expiresAt) - Date.now() - 30 * DAY_MS)).toBeLessThan(60_000);
    });

    it("caps expiry at created_at + 365 days for a session created 364 days ago", async () => {
      const { token, session } = await loginAs("ios");
      await setTimes(session.id, 364, 1);

      await verifySessionToken(pool, token);

      const { rows } = await pool.query<{ capped: boolean }>(
        `SELECT expires_at = created_at + make_interval(secs => $2::double precision) AS capped FROM sessions WHERE id = $1`,
        [session.id, SESSION_MAX_LIFETIME_SECONDS],
      );
      expect(rows[0]?.capped).toBe(true);
    });

    it("never moves expires_at earlier when it is below the ceiling", async () => {
      const { token, session } = await loginAs("web");
      // Idle window would give now()+30d, but the row already expires later than that.
      await setTimes(session.id, 0, 200);
      const before = await expiresAtMs(session.id);

      await verifySessionToken(pool, token);

      expect(await expiresAtMs(session.id)).toBeGreaterThanOrEqual(before);
    });

    it("clamps a synthetic above-ceiling expiry to the absolute ceiling", async () => {
      const { token, session } = await loginAs("web");
      // Synthetic boundary: production login does not create an expiry beyond the absolute ceiling.
      await setTimes(session.id, 0, 400);
      await verifySessionToken(pool, token);
      const { rows } = await pool.query<{ capped: boolean }>(
        "SELECT expires_at = created_at + interval '365 days' AS capped FROM sessions WHERE id = $1",
        [session.id],
      );
      expect(rows).toEqual([{ capped: true }]);
    });

    it("rejects a token unused for longer than its idle window with 401", async () => {
      const { token, session } = await loginAs("web");
      await setTimes(session.id, 31, -1);

      await expect(verifySessionToken(pool, token)).rejects.toThrow(UnauthorizedError);
      expect(await expiresAtMs(session.id)).toBeLessThan(Date.now());
    });
  });

  describe("verifySessionToken tenant binding", () => {
    afterEach(async () => {
      await pool.query("UPDATE tenants SET status = 'active'");
    });

    async function loginAs(user: { email: string }) {
      return login(pool, { email: user.email, password: "s3cret-password", platform: "web", ip: "1.1.1.1" });
    }

    it("returns the bound tenant and role of a user bound to an active tenant", async () => {
      const user = await createUser(pool, {
        email: "bound@example.com",
        passwordHash: await hashPassword("s3cret-password"),
        tenantId: getTenantZeroId(),
        role: "admin",
      });
      const { token } = await loginAs(user);

      const identity = await verifySessionToken(pool, token);
      expect(identity.tenantId).toBe(getTenantZeroId());
      expect(identity.role).toBe("admin");
    });

    it.each(["suspended", "provisioning", "deleting"])(
      "rejects a user in a %s tenant without bumping last_seen_at",
      async (status) => {
        const user = await makeUser();
        const { token, session } = await loginAs(user);
        await pool.query("UPDATE tenants SET status = $1", [status]);

        await expect(verifySessionToken(pool, token)).rejects.toThrow(UnauthorizedError);

        const { rows } = await pool.query<{ lastSeenAt: Date }>(
          'SELECT last_seen_at AS "lastSeenAt" FROM sessions WHERE id = $1',
          [session.id],
        );
        expect(rows[0]!.lastSeenAt.toISOString()).toBe(new Date(session.lastSeenAt).toISOString());
      },
    );
  });

  describe("login for a non-active tenant (issue #1041)", () => {
    async function suspendedUser() {
      const tenantId = await createTestTenant(pool);
      const user = await createUser(pool, {
        email: "suspended@example.com",
        passwordHash: await hashPassword("s3cret-password"),
        tenantId,
      });
      await withTransaction(pool, (client) => transitionTenantStatus(client, tenantId, ["active"], "suspended"));
      return user;
    }

    it("refuses the correct password like a wrong one: same error, no session, one failed attempt", async () => {
      const user = await suspendedUser();

      await expect(
        login(pool, { email: user.email, password: "s3cret-password", platform: "web", ip: "1.2.3.4" }),
      ).rejects.toThrow(UnauthorizedError);

      expect(await listSessionsForUser(pool, user.id)).toHaveLength(0);
      expect(await countRecentFailedAttempts(pool, user.email, "1.2.3.4", 3600)).toBe(1);
    });

    it("lets the same user log in once the tenant is active again", async () => {
      const user = await suspendedUser();
      const { rows } = await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM users WHERE id = $1", [user.id]);
      await withTransaction(pool, (client) =>
        transitionTenantStatus(client, rows[0]!.tenant_id, ["suspended"], "active"),
      );

      const result = await login(pool, {
        email: user.email,
        password: "s3cret-password",
        platform: "web",
        ip: "1.2.3.4",
      });

      expect(result.user.id).toBe(user.id);
    });

    it("issues the same number of queries on the pool for an unknown email, a wrong password and a suspended tenant", async () => {
      const known = await makeUser("known@example.com");
      const suspended = await suspendedUser();
      const attempts = [
        { email: "nobody@example.com", password: "s3cret-password" },
        { email: known.email, password: "wrong-password" },
        { email: suspended.email, password: "s3cret-password" },
      ];

      const counts: number[] = [];
      for (const attempt of attempts) {
        const querySpy = vi.spyOn(pool, "query");
        try {
          await expect(login(pool, { ...attempt, platform: "web", ip: "1.2.3.4" })).rejects.toThrow(UnauthorizedError);
          counts.push(querySpy.mock.calls.length);
        } finally {
          querySpy.mockRestore();
        }
      }

      expect(counts[0]).toBeGreaterThan(0);
      expect(counts).toEqual([counts[0], counts[0], counts[0]]);
    });

    it("refuses a login that reaches its session write while a suspension of the user is uncommitted", async () => {
      const admin = await createUser(pool, {
        email: "admin@example.com",
        passwordHash: await hashPassword("s3cret-password"),
        tenantId: getTenantZeroId(),
        role: "admin",
      });
      const tenantId = await createTestTenant(pool);
      const user = await createUser(pool, {
        email: "member@example.com",
        passwordHash: await hashPassword("s3cret-password"),
        tenantId,
      });
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
      await suspendedUncommitted;

      const attempt = login(pool, { email: user.email, password: "s3cret-password", platform: "web", ip: "1.2.3.4" });
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

      await expect(attempt).rejects.toThrow(UnauthorizedError);
      expect(await listSessionsForUser(pool, user.id)).toHaveLength(0);
      expect(await countRecentFailedAttempts(pool, user.email, "1.2.3.4", 3600)).toBe(1);
    });
  });

  describe("logout", () => {
    afterEach(() => {
      setSessionRevokedHook(() => {});
    });

    it("revokes only the caller's own session, leaving other sessions for the same user valid", async () => {
      const user = await makeUser();
      const a = await login(pool, { email: user.email, password: "s3cret-password", platform: "web", ip: "1.1.1.1" });
      const b = await login(pool, { email: user.email, password: "s3cret-password", platform: "ios", ip: "1.1.1.1" });

      await logout(pool, a.session.id);

      await expect(verifySessionToken(pool, a.token)).rejects.toThrow(UnauthorizedError);
      const stillValid = await verifySessionToken(pool, b.token);
      expect(stillValid.session.id).toBe(b.session.id);
    });

    it("fires the session-revoked realtime hook (issue #160) for the logged-out session only", async () => {
      const user = await makeUser();
      const a = await login(pool, { email: user.email, password: "s3cret-password", platform: "web", ip: "1.1.1.1" });
      const events: SessionRevokedEvent[] = [];
      setSessionRevokedHook((event) => events.push(event));

      await logout(pool, a.session.id);

      expect(events).toEqual([{ sessionId: a.session.id }]);
      expect(await isSessionActive(pool, a.session.id)).toBe(false);
    });
  });

  describe("revokeUserSession", () => {
    afterEach(() => {
      setSessionRevokedHook(() => {});
    });

    it("revokes a different session belonging to the same user", async () => {
      const user = await makeUser();
      const a = await login(pool, { email: user.email, password: "s3cret-password", platform: "web", ip: "1.1.1.1" });
      const b = await login(pool, { email: user.email, password: "s3cret-password", platform: "ios", ip: "1.1.1.1" });

      const revoked = await revokeUserSession(pool, user.id, b.session.id);

      expect(revoked).toBe(true);
      await expect(verifySessionToken(pool, b.token)).rejects.toThrow(UnauthorizedError);
      const stillValid = await verifySessionToken(pool, a.token);
      expect(stillValid.session.id).toBe(a.session.id);
    });

    it("fires the session-revoked realtime hook for the revoked session only, not the caller's own", async () => {
      const user = await makeUser();
      const a = await login(pool, { email: user.email, password: "s3cret-password", platform: "web", ip: "1.1.1.1" });
      const b = await login(pool, { email: user.email, password: "s3cret-password", platform: "ios", ip: "1.1.1.1" });
      const events: SessionRevokedEvent[] = [];
      setSessionRevokedHook((event) => events.push(event));

      await revokeUserSession(pool, user.id, b.session.id);

      expect(events).toEqual([{ sessionId: b.session.id }]);
      expect(await isSessionActive(pool, a.session.id)).toBe(true);
    });

    it("fires no realtime hook for an unknown session id", async () => {
      const user = await makeUser();
      const events: SessionRevokedEvent[] = [];
      setSessionRevokedHook((event) => events.push(event));

      await revokeUserSession(pool, user.id, "00000000-0000-0000-0000-000000000000");

      expect(events).toEqual([]);
    });

    it("refuses to revoke a session belonging to a different user", async () => {
      const owner = await makeUser("owner@example.com");
      const attacker = await makeUser("attacker@example.com");
      const ownerSession = await login(pool, {
        email: owner.email,
        password: "s3cret-password",
        platform: "web",
        ip: "1.1.1.1",
      });

      const revoked = await revokeUserSession(pool, attacker.id, ownerSession.session.id);

      expect(revoked).toBe(false);
      const stillValid = await verifySessionToken(pool, ownerSession.token);
      expect(stillValid.session.id).toBe(ownerSession.session.id);
    });

    it("returns false for an unknown session id", async () => {
      const user = await makeUser();
      expect(await revokeUserSession(pool, user.id, "00000000-0000-0000-0000-000000000000")).toBe(false);
    });
  });

  describe("revokeOtherUserSessions (issue #1650)", () => {
    afterEach(() => {
      setSessionRevokedHook(() => {});
    });

    const password = "s3cret-password";

    async function threeSessions(email = "person@example.com") {
      const user = await makeUser(email, password);
      const sessions = [];
      for (const platform of ["web", "ios", "macos"] as const) {
        sessions.push(await login(pool, { email: user.email, password, platform, ip: "1.1.1.1" }));
      }
      const [current, ...others] = sessions;
      if (!current) throw new Error("no session");
      return { user, current, others };
    }

    async function registration(userId: string, sessionId: string | null) {
      return upsertWebPushSubscription(pool, {
        userId,
        sessionId,
        endpoint: `https://push.example.test/${randomUUID()}`,
        p256dh: "key",
        authSecret: "secret",
      });
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

    it("revokes every other session and its push registrations, keeping the caller's own and sessionless ones", async () => {
      const { user, current, others } = await threeSessions();
      const ownRegistration = await registration(user.id, current.session.id);
      const otherRegistrations = await Promise.all(others.map((other) => registration(user.id, other.session.id)));
      const sessionless = await registration(user.id, null);

      const count = await withTransaction(pool, (client) =>
        revokeOtherUserSessions(client, user.id, current.session.id),
      );

      expect(count).toBe(2);
      expect((await verifySessionToken(pool, current.token)).session.id).toBe(current.session.id);
      for (const other of others)
        await expect(verifySessionToken(pool, other.token)).rejects.toThrow(UnauthorizedError);
      for (const other of otherRegistrations) expect(await revokedAt(other.id)).toBeInstanceOf(Date);
      expect(await revokedAt(ownRegistration.id)).toBeNull();
      expect(await revokedAt(sessionless.id)).toBeNull();
    });

    it("fires one session-revoked event per revoked session, only after the commit", async () => {
      const { user, current, others } = await threeSessions();
      const events: SessionRevokedEvent[] = [];
      setSessionRevokedHook((event) => events.push(event));
      let beforeCommit: SessionRevokedEvent[] | undefined;

      await withTransaction(pool, async (client) => {
        await revokeOtherUserSessions(client, user.id, current.session.id);
        beforeCommit = [...events];
      });

      expect(beforeCommit).toEqual([]);
      expect(events.map((event) => event.sessionId).sort()).toEqual(others.map((other) => other.session.id).sort());
    });

    it("never revokes another user's sessions", async () => {
      const { user, current } = await threeSessions("caller@example.com");
      const otherUser = await threeSessions("other@example.com");
      const theirRegistration = await registration(otherUser.user.id, otherUser.others[0]!.session.id);

      await withTransaction(pool, (client) => revokeOtherUserSessions(client, user.id, current.session.id));

      for (const session of [otherUser.current, ...otherUser.others]) {
        expect((await verifySessionToken(pool, session.token)).session.id).toBe(session.session.id);
      }
      expect(await revokedAt(theirRegistration.id)).toBeNull();
    });

    it("returns 0 and fires nothing when the caller has no other active session", async () => {
      const user = await makeUser("single@example.com", password);
      const only = await login(pool, { email: user.email, password, platform: "ios", ip: "1.1.1.1" });
      const events: SessionRevokedEvent[] = [];
      setSessionRevokedHook((event) => events.push(event));

      expect(await withTransaction(pool, (client) => revokeOtherUserSessions(client, user.id, only.session.id))).toBe(
        0,
      );
      expect(events).toEqual([]);
      expect(await isSessionActive(pool, only.session.id)).toBe(true);
    });

    it("revokes nothing and fires no event when its transaction rolls back", async () => {
      const { user, current, others } = await threeSessions();
      const otherRegistration = await registration(user.id, others[0]!.session.id);
      const events: SessionRevokedEvent[] = [];
      setSessionRevokedHook((event) => events.push(event));
      const rollback = new Error("roll back");

      await expect(
        withTransaction(pool, async (client) => {
          expect(await revokeOtherUserSessions(client, user.id, current.session.id)).toBe(2);
          throw rollback;
        }),
      ).rejects.toBe(rollback);

      expect(events).toEqual([]);
      for (const other of others) expect(await isSessionActive(pool, other.session.id)).toBe(true);
      expect(await revokedAt(otherRegistration.id)).toBeNull();
    });
  });

  describe("login replacing the sessions of its installation (issue #1687)", () => {
    const password = "s3cret-password";
    const deviceId = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
    const otherDeviceId = "0b7e1f2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
    // The role the API connects as. Every login below runs on it inside a system scope, as the auth listener runs it.
    let runtime: Pool;

    beforeEach(async () => {
      runtime ??= await createRuntimeRolePool(pool, "semprec_data");
    });

    afterEach(() => {
      setSessionRevokedHook(() => {});
    });

    afterAll(async () => {
      await runtime?.end();
    });

    function signIn(
      email: string,
      device?: LoginDevice,
      attempt: { password?: string; ip?: string } = {},
    ): Promise<LoginResult> {
      return runAsSystem("test:login", () =>
        login(runtime, {
          email,
          password: attempt.password ?? password,
          platform: "ios",
          ip: attempt.ip ?? "1.1.1.1",
          device,
        }),
      );
    }

    function authenticate(token: string) {
      return runAsSystem("test:authenticate", () => verifySessionToken(runtime, token));
    }

    async function expectAccepted(...logins: LoginResult[]): Promise<void> {
      for (const { token, session } of logins) expect((await authenticate(token)).session.id).toBe(session.id);
    }

    async function registration(userId: string, sessionId: string | null): Promise<string> {
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

    function recordRevocations(): SessionRevokedEvent[] {
      const events: SessionRevokedEvent[] = [];
      setSessionRevokedHook((event) => events.push(event));
      return events;
    }

    /** Resolves once exactly `count` backends of the test database server wait for a lock. */
    async function expectWaitingBackends(count: number): Promise<void> {
      await vi.waitFor(
        async () => {
          const { rows } = await pool.query<{ waiting: number }>(
            "SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted",
          );
          expect(rows[0]?.waiting).toBe(count);
        },
        { timeout: 20_000, interval: 25 },
      );
    }

    /**
     * Locks one session row on another connection until `release` is called. A login whose replacement has
     * to revoke that session stops there: after it took its installation lock and created its session, and
     * before it commits. `done` settles when the holding transaction has ended.
     */
    async function holdSessionRow(sessionId: string): Promise<{ release: () => void; done: Promise<void> }> {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markLocked!: () => void;
      const locked = new Promise<void>((resolve) => {
        markLocked = resolve;
      });
      const done = withTransaction(pool, async (client) => {
        await client.query<{ id: string }>("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [sessionId]);
        markLocked();
        await held;
      });
      await Promise.race([locked, done]);
      return { release, done };
    }

    it("revokes the earlier session of the same deviceId and its push registrations, and keeps the user's other sessions", async () => {
      const user = await makeUser("person@example.com", password);
      const otherDevice = await signIn(user.email, { deviceId: otherDeviceId });
      const withoutDevice = await signIn(user.email);
      const previous = await signIn(user.email, { deviceId });
      const previousRegistration = await registration(user.id, previous.session.id);
      await registration(user.id, otherDevice.session.id);
      await registration(user.id, withoutDevice.session.id);
      await registration(user.id, null);

      const next = await signIn(user.email, { deviceId });

      await expect(authenticate(previous.token)).rejects.toThrow(UnauthorizedError);
      await expectAccepted(next, otherDevice, withoutDevice);
      expect(await revokedRegistrations(user.id)).toEqual([previousRegistration]);
    });

    it.each<[string, LoginDevice | undefined]>([
      ["another deviceId", { deviceId: otherDeviceId }],
      ["a null deviceId", { deviceId: null }],
      ["no device", undefined],
    ])("revokes nothing when the next login carries %s", async (_name, device) => {
      const user = await makeUser("person@example.com", password);
      const first = await signIn(user.email, { deviceId });
      await registration(user.id, first.session.id);
      const events = recordRevocations();

      const second = await signIn(user.email, device);

      await expectAccepted(first, second);
      expect(await revokedRegistrations(user.id)).toEqual([]);
      expect(events).toEqual([]);
    });

    it("leaves another user's session with the same deviceId alone, in both directions", async () => {
      const owner = await makeUser("owner@example.com", password);
      const other = await makeUser("other@example.com", password);
      const ownerSession = await signIn(owner.email, { deviceId });
      await registration(owner.id, ownerSession.session.id);
      const events = recordRevocations();

      const otherSession = await signIn(other.email, { deviceId });

      await expectAccepted(ownerSession, otherSession);
      expect(await revokedRegistrations(owner.id)).toEqual([]);
      expect(events).toEqual([]);

      const ownerNext = await signIn(owner.email, { deviceId });

      await expectAccepted(otherSession, ownerNext);
      expect(events).toEqual([{ sessionId: ownerSession.session.id }]);
    });

    it("announces the replaced session only, and only once its revocation is committed", async () => {
      const user = await makeUser("person@example.com", password);
      const loggedOut = await signIn(user.email, { deviceId });
      await logout(pool, loggedOut.session.id);
      const previous = await signIn(user.email, { deviceId });
      const announced: Array<{ sessionId: string; stillActive: Promise<boolean> }> = [];
      setSessionRevokedHook((event) => {
        // Read on another connection as the event fires: an uncommitted revocation would still read as active.
        const stillActive = isSessionActive(pool, event.sessionId);
        // Awaited below; observed here too, so a failed read is never an unhandled rejection.
        stillActive.catch(() => undefined);
        announced.push({ sessionId: event.sessionId, stillActive });
      });

      await signIn(user.email, { deviceId });

      expect(announced.map((event) => event.sessionId)).toEqual([previous.session.id]);
      for (const event of announced) expect(await event.stillActive).toBe(false);
    });

    it.each([
      ["the same spelling", deviceId],
      ["another spelling", deviceId.toUpperCase()],
    ])(
      "leaves exactly one active session when two logins of one installation overlap, the second with %s of the deviceId",
      async (_name, secondDeviceId) => {
        const user = await makeUser("person@example.com", password);
        const previous = await signIn(user.email, { deviceId });
        const holder = await holdSessionRow(previous.session.id);

        const overlapping: Array<Promise<LoginResult>> = [];
        try {
          overlapping.push(signIn(user.email, { deviceId }));
          await expectWaitingBackends(1);
          overlapping.push(signIn(user.email, { deviceId: secondDeviceId }));
          await expectWaitingBackends(2);
        } finally {
          holder.release();
          await Promise.allSettled([holder.done, ...overlapping]);
        }
        await holder.done;
        const [first, second] = await Promise.all(overlapping);
        if (!first || !second) throw new Error("both overlapping logins must have started");

        // The second login waited for the first one's commit and then replaced the first one's session.
        expect((await listActiveSessionsForUser(pool, user.id)).map((session) => session.id)).toEqual([
          second.session.id,
        ]);
        await expectAccepted(second);
        await expect(authenticate(first.token)).rejects.toThrow(UnauthorizedError);
        await expect(authenticate(previous.token)).rejects.toThrow(UnauthorizedError);
      },
    );

    it("holds the installation lock in a two-key class of its own and leaves the single-key lock of the same hash free", async () => {
      const user = await makeUser("person@example.com", password);
      const previous = await signIn(user.email, { deviceId });
      const holder = await holdSessionRow(previous.session.id);
      let stopped: Promise<LoginResult> | undefined;
      let probe: { singleKeyFree: boolean; installationKeyFree: boolean } | undefined;
      try {
        stopped = signIn(user.email, { deviceId });
        await expectWaitingBackends(1);
        // The login holds its installation lock here. Each probe asks for a lock without waiting for it.
        probe = await withTransaction(pool, async (client) => {
          const { rows } = await client.query<{ singleKeyFree: boolean; installationKeyFree: boolean }>(
            `SELECT pg_try_advisory_xact_lock(hashtext($2)) AS "singleKeyFree",
                    pg_try_advisory_xact_lock($1::int4, hashtext($2)) AS "installationKeyFree"`,
            [SESSION_DEVICE_LOCK_CLASS, `semprec_device:${user.id}:${deviceId}`],
          );
          return rows[0];
        });
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, stopped]);
      }
      await holder.done;
      await stopped;

      expect(probe).toEqual({ singleKeyFree: true, installationKeyFree: false });
    });

    it("does not deadlock a transaction that takes the single-key lock of the same hash and then the user row", async () => {
      const user = await makeUser("person@example.com", password);
      const previous = await signIn(user.email, { deviceId });
      const holder = await holdSessionRow(previous.session.id);
      const overlapping: Array<Promise<LoginResult>> = [];
      let mutation: Promise<void> | undefined;
      try {
        overlapping.push(signIn(user.email, { deviceId }));
        await expectWaitingBackends(1);
        // An admin mutation's lock order (`lockTarget`): a single-key advisory lock, then the user row
        // `FOR UPDATE`, which waits here for the first login. The key has this installation's hash, as the
        // membership key would for a deviceId chosen to collide with it.
        mutation = withTransaction(pool, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`semprec_device:${user.id}:${deviceId}`]);
          await client.query<{ id: string }>("SELECT id FROM users WHERE id = $1 FOR UPDATE", [user.id]);
        });
        await expectWaitingBackends(2);
        overlapping.push(signIn(user.email, { deviceId }));
        await expectWaitingBackends(3);
      } finally {
        holder.release();
        await Promise.allSettled([holder.done, mutation, ...overlapping]);
      }
      await holder.done;
      await mutation;
      const [first, second] = await Promise.all(overlapping);
      if (!first || !second) throw new Error("both overlapping logins must have started");

      expect((await listActiveSessionsForUser(pool, user.id)).map((session) => session.id)).toEqual([
        second.session.id,
      ]);
      await expectAccepted(second);
      await expect(authenticate(first.token)).rejects.toThrow(UnauthorizedError);
    });

    it("revokes nothing when the password is wrong", async () => {
      const user = await makeUser("person@example.com", password);
      const first = await signIn(user.email, { deviceId });
      await registration(user.id, first.session.id);
      const events = recordRevocations();

      await expect(signIn(user.email, { deviceId }, { password: "wrong-password" })).rejects.toThrow(UnauthorizedError);

      await expectAccepted(first);
      expect(await listSessionsForUser(pool, user.id)).toHaveLength(1);
      expect(await revokedRegistrations(user.id)).toEqual([]);
      expect(events).toEqual([]);
    });

    it("revokes nothing when the correct password is refused by the lockout", async () => {
      const user = await makeUser("person@example.com", password);
      const first = await signIn(user.email, { deviceId }, { ip: "2.2.2.2" });
      await registration(user.id, first.session.id);
      const events = recordRevocations();
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await expect(signIn(user.email, { deviceId }, { password: "wrong-password", ip: "3.3.3.3" })).rejects.toThrow(
          UnauthorizedError,
        );
      }

      await expect(signIn(user.email, { deviceId }, { ip: "3.3.3.3" })).rejects.toThrow(UnauthorizedError);

      await expectAccepted(first);
      expect(await listSessionsForUser(pool, user.id)).toHaveLength(1);
      expect(await revokedRegistrations(user.id)).toEqual([]);
      expect(events).toEqual([]);
    });

    it("rolls the replacement back and announces nothing when the login transaction fails after it", async () => {
      const user = await makeUser("person@example.com", password);
      const first = await signIn(user.email, { deviceId });
      await registration(user.id, first.session.id);
      const events = recordRevocations();
      // The success row is the transaction's last write, after the replacement; refusing it fails the login there.
      await pool.query(`
        CREATE FUNCTION login_test_reject_success() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.succeeded THEN RAISE EXCEPTION 'forced failure'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER login_test_reject_success BEFORE INSERT ON login_attempts
          FOR EACH ROW EXECUTE FUNCTION login_test_reject_success();`);
      try {
        await expect(signIn(user.email, { deviceId })).rejects.toThrow("forced failure");
      } finally {
        await pool.query(
          "DROP TRIGGER login_test_reject_success ON login_attempts; DROP FUNCTION login_test_reject_success()",
        );
      }

      await expectAccepted(first);
      expect(await listSessionsForUser(pool, user.id)).toHaveLength(1);
      expect(await revokedRegistrations(user.id)).toEqual([]);
      expect(events).toEqual([]);
    });

    it("lists one active session per deviceId after repeated logins", async () => {
      const user = await makeUser("person@example.com", password);
      for (let i = 0; i < 3; i++) await signIn(user.email, { deviceId });
      const lastOfDevice = await signIn(user.email, { deviceId });
      await signIn(user.email, { deviceId: otherDeviceId });
      const lastOfOtherDevice = await signIn(user.email, { deviceId: otherDeviceId });
      const withoutDevice = [await signIn(user.email), await signIn(user.email)];

      const active = await listActiveSessionsForUser(pool, user.id);

      expect(active.map((session) => session.id).sort()).toEqual(
        [lastOfDevice, lastOfOtherDevice, ...withoutDevice].map((result) => result.session.id).sort(),
      );
    });
  });

  describe("bootstrapFirstAccount (issue #233)", () => {
    const SETUP_TOKEN = "correct-setup-token";

    it("hashes the password and creates a user the caller can immediately log in as", async () => {
      const account = await bootstrapFirstAccount(pool, SETUP_TOKEN, SETUP_TOKEN, {
        email: "New.User@Example.com",
        password: "s3cret-password",
      });

      expect(account.email).toBe("new.user@example.com");
      expect((account as { passwordHash?: unknown }).passwordHash).toBeUndefined();
      const result = await login(pool, {
        email: "new.user@example.com",
        password: "s3cret-password",
        platform: "web",
        ip: "1.2.3.4",
      });
      expect(result.user.id).toBe(account.id);
    });

    it("rejects a malformed email", async () => {
      await expect(
        bootstrapFirstAccount(pool, SETUP_TOKEN, SETUP_TOKEN, { email: "not-an-email", password: "s3cret-password" }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects a too-short password", async () => {
      await expect(
        bootstrapFirstAccount(pool, SETUP_TOKEN, SETUP_TOKEN, { email: "person@example.com", password: "short" }),
      ).rejects.toThrow(ValidationError);
    });

    it("creates the account with a matching token against an empty users table", async () => {
      const account = await bootstrapFirstAccount(pool, SETUP_TOKEN, SETUP_TOKEN, {
        email: "owner@example.com",
        password: "s3cret-password",
      });
      expect(account.email).toBe("owner@example.com");

      const result = await login(pool, {
        email: "owner@example.com",
        password: "s3cret-password",
        platform: "web",
        ip: "1.2.3.4",
      });
      expect(result.user.id).toBe(account.id);
    });

    it("rejects a wrong token with NotFoundError", async () => {
      await expect(
        bootstrapFirstAccount(pool, SETUP_TOKEN, "wrong-token", {
          email: "owner@example.com",
          password: "s3cret-password",
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it("returns NotFoundError once a user already exists, even with the correct token", async () => {
      await makeUser();
      await expect(
        bootstrapFirstAccount(pool, SETUP_TOKEN, SETUP_TOKEN, {
          email: "owner@example.com",
          password: "s3cret-password",
        }),
      ).rejects.toThrow(NotFoundError);
    });

    it("permits exactly one winner when two callers race with the correct token", async () => {
      const results = await Promise.allSettled([
        bootstrapFirstAccount(pool, SETUP_TOKEN, SETUP_TOKEN, {
          email: "first@example.com",
          password: "s3cret-password",
        }),
        bootstrapFirstAccount(pool, SETUP_TOKEN, SETUP_TOKEN, {
          email: "second@example.com",
          password: "s3cret-password",
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(NotFoundError);

      const { rows } = await pool.query("SELECT count(*)::int AS count FROM users");
      expect(rows[0].count).toBe(1);
    });
  });
});
