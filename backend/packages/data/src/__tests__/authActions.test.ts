import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { hashPassword } from "../auth/passwordHash.js";
import { createUser } from "../auth/usersStore.js";
import { getActiveSessionByTokenHash, listSessionsForUser } from "../auth/sessionsStore.js";
import { countRecentFailedAttempts } from "../auth/loginAttemptsStore.js";
import { login, verifySessionToken, logout, revokeUserSession, bootstrapFirstAccount } from "../auth/authActions.js";
import { LOCKOUT_THRESHOLD } from "../auth/loginLockout.js";
import { NotFoundError, UnauthorizedError, ValidationError } from "../errors.js";

let pool: Pool;

async function makeUser(email = "person@example.com", password = "s3cret-password") {
  return createUser(pool, { email, passwordHash: await hashPassword(password) });
}

describe("auth actions (issue #140)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
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

      expect(result.user).toEqual({ id: user.id, email: user.email, locale: user.locale, createdAt: user.createdAt });
      expect(result.token).toBeTruthy();
      expect((result.user as { passwordHash?: unknown }).passwordHash).toBeUndefined();

      const identity = await verifySessionToken(pool, result.token);
      expect(identity.user.id).toBe(user.id);
      expect(identity.session.id).toBe(result.session.id);
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

  describe("logout", () => {
    it("revokes only the caller's own session, leaving other sessions for the same user valid", async () => {
      const user = await makeUser();
      const a = await login(pool, { email: user.email, password: "s3cret-password", platform: "web", ip: "1.1.1.1" });
      const b = await login(pool, { email: user.email, password: "s3cret-password", platform: "ios", ip: "1.1.1.1" });

      await logout(pool, a.session.id);

      await expect(verifySessionToken(pool, a.token)).rejects.toThrow(UnauthorizedError);
      const stillValid = await verifySessionToken(pool, b.token);
      expect(stillValid.session.id).toBe(b.session.id);
    });
  });

  describe("revokeUserSession", () => {
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
