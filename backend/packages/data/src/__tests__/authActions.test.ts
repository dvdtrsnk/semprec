import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { hashPassword } from "../auth/passwordHash.js";
import { createUser } from "../auth/usersStore.js";
import { getActiveSessionByTokenHash, listSessionsForUser } from "../auth/sessionsStore.js";
import { countRecentFailedAttempts } from "../auth/loginAttemptsStore.js";
import { login, verifySessionToken, logout, revokeUserSession } from "../auth/authActions.js";
import { UnauthorizedError } from "../errors.js";

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
});
