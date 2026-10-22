import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase, tenantForNextTestUser } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { hashPassword, verifyPassword } from "../auth/passwordHash.js";
import { createUser, getUserByEmail } from "../auth/usersStore.js";
import { createSession, getActiveSessionByTokenHash } from "../auth/sessionsStore.js";
import { setSessionRevokedHook, type SessionRevokedEvent } from "../realtimeHook.js";
import { generateOpaqueToken, hashToken } from "../auth/token.js";
import {
  PASSWORD_RESET_MAX_REQUESTS_PER_WINDOW,
  PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS,
  PASSWORD_RESET_REQUEST_MIN_DURATION_MS,
  requestPasswordReset,
  resetPassword,
} from "../auth/passwordResetActions.js";
import { countRecentPasswordResetTokens } from "../auth/passwordResetStore.js";
import { registerPushSubscription } from "../push/pushSubscriptionActions.js";
import { listPushSubscriptionsForUser } from "../push/pushSubscriptionsStore.js";
import type { PasswordResetMailer, SendPasswordResetEmailInput } from "../auth/passwordResetMail.js";
import { transitionTenantStatus } from "../tenancy/tenantsStore.js";
import { createTestTenant } from "../testSupport/tenantFixtures.js";
import { suspendAccount } from "../tenancy/accountsAdminStore.js";
import { PasswordResetTokenError, ValidationError } from "../errors.js";
import { logger } from "../auth/logger.js";

let pool: Pool;

const OLD_PASSWORD = "s3cret-password";
const APP_BASE_URL = "https://app.example.test";

async function makeUser(email = "person@example.com") {
  return createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email,
    passwordHash: await hashPassword(OLD_PASSWORD),
  });
}

function fakeMailer(): PasswordResetMailer & { sent: SendPasswordResetEmailInput[] } {
  const sent: SendPasswordResetEmailInput[] = [];
  return {
    sent,
    async sendPasswordResetEmail(input) {
      sent.push(input);
    },
  };
}

function tokenFromUrl(resetUrl: string): string {
  const token = new URLSearchParams(new URL(resetUrl).hash.slice(1)).get("token");
  if (!token) throw new Error(`expected a token in ${resetUrl}`);
  return token;
}

/** `resetPassword` requires a `PoolClient` (a caller-managed transaction) — this mirrors the HTTP handler's `withTransaction` wrapping. */
function resetPasswordInTransaction(testPool: Pool, input: Parameters<typeof resetPassword>[1]): Promise<void> {
  return withTransaction(testPool, (client) => resetPassword(client, input));
}

describe("password reset actions (issue #142)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  describe("requestPasswordReset", () => {
    it("emails a reset link for a known email", async () => {
      const user = await makeUser();
      const mailer = fakeMailer();

      await requestPasswordReset(pool, mailer, { email: user.email, appBaseUrl: APP_BASE_URL });

      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.to).toBe(user.email);
      expect(mailer.sent[0]!.resetUrl.startsWith(`${APP_BASE_URL}/?page=password-reset#token=`)).toBe(true);
      expect(new URL(mailer.sent[0]!.resetUrl).searchParams.has("token")).toBe(false);
    });

    it("is a silent no-op for an unknown email — no mail sent, no error", async () => {
      const mailer = fakeMailer();

      await expect(
        requestPasswordReset(pool, mailer, { email: "nobody@example.com", appBaseUrl: APP_BASE_URL }),
      ).resolves.toBeUndefined();

      expect(mailer.sent).toHaveLength(0);
    });

    describe("timing floor", () => {
      async function elapsedMs(run: () => Promise<void>): Promise<number> {
        const startedAt = performance.now();
        await run();
        return performance.now() - startedAt;
      }

      it("takes at least the minimum duration for an unknown email", async () => {
        const elapsed = await elapsedMs(() =>
          requestPasswordReset(pool, fakeMailer(), { email: "nobody@example.com", appBaseUrl: APP_BASE_URL }),
        );
        expect(elapsed).toBeGreaterThanOrEqual(PASSWORD_RESET_REQUEST_MIN_DURATION_MS - 5);
      });

      it("takes at least the minimum duration for an account at its token cap", async () => {
        const user = await makeUser();
        for (let i = 0; i < PASSWORD_RESET_MAX_REQUESTS_PER_WINDOW; i++) {
          await requestPasswordReset(pool, fakeMailer(), { email: user.email, appBaseUrl: APP_BASE_URL });
        }
        const mailer = fakeMailer();
        const elapsed = await elapsedMs(() =>
          requestPasswordReset(pool, mailer, { email: user.email, appBaseUrl: APP_BASE_URL }),
        );
        expect(mailer.sent).toHaveLength(0);
        expect(elapsed).toBeGreaterThanOrEqual(PASSWORD_RESET_REQUEST_MIN_DURATION_MS - 5);
      });

      it("takes at least the minimum duration when a token is issued", async () => {
        const user = await makeUser();
        const mailer = fakeMailer();
        const elapsed = await elapsedMs(() =>
          requestPasswordReset(pool, mailer, { email: user.email, appBaseUrl: APP_BASE_URL }),
        );
        expect(mailer.sent).toHaveLength(1);
        expect(elapsed).toBeGreaterThanOrEqual(PASSWORD_RESET_REQUEST_MIN_DURATION_MS - 5);
      });
    });

    it("normalizes the email the same way login does (trims and lowercases before lookup)", async () => {
      const user = await makeUser();
      const mailer = fakeMailer();

      await requestPasswordReset(pool, mailer, { email: `  ${user.email.toUpperCase()}  `, appBaseUrl: APP_BASE_URL });

      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.to).toBe(user.email);
    });

    it("never puts the raw token in the database — only its hash is derivable from it", async () => {
      const user = await makeUser();
      const mailer = fakeMailer();

      await requestPasswordReset(pool, mailer, { email: user.email, appBaseUrl: APP_BASE_URL });
      const token = tokenFromUrl(mailer.sent[0]!.resetUrl);

      const { rows } = await pool.query<{ token_hash: string }>(
        `SELECT token_hash FROM password_reset_tokens WHERE user_id = $1`,
        [user.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_hash).not.toBe(token);
      expect(rows[0]!.token_hash).toBe(hashToken(token));
    });

    it("stops issuing new tokens (and stops emailing) once the per-window request cap is hit", async () => {
      const user = await makeUser();

      for (let i = 0; i < PASSWORD_RESET_MAX_REQUESTS_PER_WINDOW; i++) {
        const mailer = fakeMailer();
        await requestPasswordReset(pool, mailer, { email: user.email, appBaseUrl: APP_BASE_URL });
        expect(mailer.sent).toHaveLength(1);
      }

      // The next request past the cap is a silent no-op, same shape as an unknown email.
      const mailer = fakeMailer();
      await expect(
        requestPasswordReset(pool, mailer, { email: user.email, appBaseUrl: APP_BASE_URL }),
      ).resolves.toBeUndefined();
      expect(mailer.sent).toHaveLength(0);

      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*) FROM password_reset_tokens WHERE user_id = $1`,
        [user.id],
      );
      expect(Number(rows[0]!.count)).toBe(PASSWORD_RESET_MAX_REQUESTS_PER_WINDOW);
    });

    it("resolves after the timing floor without waiting for the mail send to finish", async () => {
      const user = await makeUser();
      const sent: SendPasswordResetEmailInput[] = [];
      let release!: () => void;
      const pendingSend = new Promise<void>((resolve) => {
        release = resolve;
      });
      const mailer: PasswordResetMailer = {
        sendPasswordResetEmail(input) {
          sent.push(input);
          return pendingSend;
        },
      };

      await expect(
        requestPasswordReset(pool, mailer, { email: user.email, appBaseUrl: APP_BASE_URL }),
      ).resolves.toBeUndefined();

      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe(user.email);
      release();
    });

    it("still resolves and keeps the token row when the mail send rejects, logging the failure", async () => {
      const user = await makeUser();
      // An SMTP refusal echoes the recipient, as a real one does; the log must not carry it.
      const sendError = Object.assign(new Error(`550 rejected <${user.email}>`), {
        code: "EENVELOPE",
        responseCode: 550,
        response: `550 rejected <${user.email}>`,
        rejected: [user.email],
      });
      const mailer: PasswordResetMailer = {
        sendPasswordResetEmail() {
          return Promise.reject(sendError);
        },
      };
      const loggerError = vi.spyOn(logger, "error").mockImplementation(() => undefined);

      try {
        await expect(
          requestPasswordReset(pool, mailer, { email: user.email, appBaseUrl: APP_BASE_URL }),
        ).resolves.toBeUndefined();

        await vi.waitFor(() => {
          expect(loggerError).toHaveBeenCalledWith(
            { userId: user.id, err: { errorName: "Error", errorCode: "EENVELOPE", responseCode: 550 } },
            "requestPasswordReset: failed to send the password-reset email",
          );
        });
        expect(JSON.stringify(loggerError.mock.calls)).not.toContain(user.email);
        expect(await countRecentPasswordResetTokens(pool, user.id, PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS)).toBe(1);
      } finally {
        loggerError.mockRestore();
      }
    });
  });

  describe("resetPassword", () => {
    async function requestAndGetToken(email: string): Promise<string> {
      const mailer = fakeMailer();
      await requestPasswordReset(pool, mailer, { email, appBaseUrl: APP_BASE_URL });
      return tokenFromUrl(mailer.sent[0]!.resetUrl);
    }

    it("writes a new Argon2id password hash and lets the old password fail to verify", async () => {
      const user = await makeUser();
      const token = await requestAndGetToken(user.email);

      await resetPasswordInTransaction(pool, { token, newPassword: "a-brand-new-password" });

      const updated = await getUserByEmail(pool, user.email);
      expect(updated).not.toBeNull();
      expect(await verifyPassword(updated!.passwordHash, "a-brand-new-password")).toBe(true);
      expect(await verifyPassword(updated!.passwordHash, OLD_PASSWORD)).toBe(false);
    });

    it("rejects a second consumption of the same token with a 'consumed' reason", async () => {
      const user = await makeUser();
      const token = await requestAndGetToken(user.email);

      await resetPasswordInTransaction(pool, { token, newPassword: "first-new-password" });

      const err = await resetPasswordInTransaction(pool, { token, newPassword: "second-new-password" }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PasswordResetTokenError);
      expect((err as PasswordResetTokenError).reason).toBe("consumed");

      // The second, rejected attempt must not have overwritten the password the first attempt set.
      const updated = await getUserByEmail(pool, user.email);
      expect(await verifyPassword(updated!.passwordHash, "first-new-password")).toBe(true);
    });

    it("rejects a newPassword shorter than 8 characters without consuming the token", async () => {
      const user = await makeUser();
      const token = await requestAndGetToken(user.email);

      const err = await resetPasswordInTransaction(pool, { token, newPassword: "1234567" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).details).toEqual({ field: "newPassword" });

      const { rows } = await pool.query<{ consumed_at: Date | null }>(
        `SELECT consumed_at FROM password_reset_tokens WHERE token_hash = $1`,
        [hashToken(token)],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.consumed_at).toBeNull();

      // The same token still works with a password that meets the minimum.
      await resetPasswordInTransaction(pool, { token, newPassword: "12345678" });
      const updated = await getUserByEmail(pool, user.email);
      expect(await verifyPassword(updated!.passwordHash, "12345678")).toBe(true);
    });

    it("rejects a token that was never issued with an 'invalid' reason", async () => {
      const err = await resetPasswordInTransaction(pool, {
        token: "not-a-real-token",
        newPassword: "whatever-password",
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PasswordResetTokenError);
      expect((err as PasswordResetTokenError).reason).toBe("invalid");
    });

    it("rejects an expired token with an 'expired' reason", async () => {
      const user = await makeUser();
      const token = await requestAndGetToken(user.email);
      await pool.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [
        user.id,
      ]);

      const err = await resetPasswordInTransaction(pool, { token, newPassword: "whatever-password" }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PasswordResetTokenError);
      expect((err as PasswordResetTokenError).reason).toBe("expired");

      const updated = await getUserByEmail(pool, user.email);
      expect(await verifyPassword(updated!.passwordHash, OLD_PASSWORD)).toBe(true);
    });

    it("revokes every pre-existing session for the user on a successful reset", async () => {
      const user = await makeUser();
      const { tokenHash } = generateOpaqueToken();
      await createSession(pool, {
        userId: user.id,
        tokenHash,
        platform: "web",
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(await getActiveSessionByTokenHash(pool, tokenHash)).not.toBeNull();

      const token = await requestAndGetToken(user.email);
      await resetPasswordInTransaction(pool, { token, newPassword: "a-brand-new-password" });

      expect(await getActiveSessionByTokenHash(pool, tokenHash)).toBeNull();
    });

    it("fires the session-revoked realtime hook (issue #160) for every session it revokes", async () => {
      const user = await makeUser();
      const sessionA = await createSession(pool, {
        userId: user.id,
        tokenHash: generateOpaqueToken().tokenHash,
        platform: "web",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const sessionB = await createSession(pool, {
        userId: user.id,
        tokenHash: generateOpaqueToken().tokenHash,
        platform: "ios",
        expiresAt: new Date(Date.now() + 60_000),
      });

      const events: SessionRevokedEvent[] = [];
      setSessionRevokedHook((event) => events.push(event));
      try {
        const token = await requestAndGetToken(user.email);
        await resetPasswordInTransaction(pool, { token, newPassword: "a-brand-new-password" });

        expect(events.map((event) => event.sessionId).sort()).toEqual([sessionA.id, sessionB.id].sort());
      } finally {
        setSessionRevokedHook(() => {});
      }
    });

    it("revokes every active push registration of the user, web push, APNs and session-less, and leaves another user's active", async () => {
      const user = await makeUser();
      const other = await makeUser("other@example.com");
      const session = await createSession(pool, {
        userId: user.id,
        tokenHash: generateOpaqueToken().tokenHash,
        platform: "ios",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const webOnSession = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: session.id,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/user-web",
        p256dh: "key",
        authSecret: "secret",
      });
      const apnsOnSession = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: session.id,
        channel: "apns",
        platform: "ios",
        deviceToken: "device-token-user",
        apnsEnvironment: "sandbox",
      });
      const sessionless = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: null,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/user-sessionless",
        p256dh: "key",
        authSecret: "secret",
      });
      const otherSessionless = await registerPushSubscription(pool, {
        userId: other.id,
        sessionId: null,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/other-sessionless",
        p256dh: "key",
        authSecret: "secret",
      });

      const token = await requestAndGetToken(user.email);
      await resetPasswordInTransaction(pool, { token, newPassword: "a-brand-new-password" });

      const userRows = await listPushSubscriptionsForUser(pool, user.id);
      expect(userRows.map((row) => row.id).sort()).toEqual([webOnSession.id, apnsOnSession.id, sessionless.id].sort());
      expect(userRows.every((row) => row.revokedAt !== null)).toBe(true);

      const otherRows = await listPushSubscriptionsForUser(pool, other.id);
      expect(otherRows.map((row) => row.id)).toEqual([otherSessionless.id]);
      expect(otherRows[0]!.revokedAt).toBeNull();
    });

    it("revokes no push registration when the token is invalid", async () => {
      const user = await makeUser();
      const registration = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: null,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/invalid-token",
        p256dh: "key",
        authSecret: "secret",
      });

      const err = await resetPasswordInTransaction(pool, {
        token: "not-a-real-token",
        newPassword: "whatever-password",
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PasswordResetTokenError);

      const [row] = await listPushSubscriptionsForUser(pool, user.id);
      expect(row!.id).toBe(registration.id);
      expect(row!.revokedAt).toBeNull();
    });

    it("revokes no push registration when the token was already consumed", async () => {
      const user = await makeUser();
      const token = await requestAndGetToken(user.email);
      await resetPasswordInTransaction(pool, { token, newPassword: "first-new-password" });

      // Registered after the first reset, so the second attempt's revocation would be visible.
      const registration = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: null,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/consumed-token",
        p256dh: "key",
        authSecret: "secret",
      });

      const err = await resetPasswordInTransaction(pool, { token, newPassword: "second-new-password" }).catch(
        (e: unknown) => e,
      );
      expect((err as PasswordResetTokenError).reason).toBe("consumed");

      const [row] = await listPushSubscriptionsForUser(pool, user.id);
      expect(row!.id).toBe(registration.id);
      expect(row!.revokedAt).toBeNull();
    });

    it("revokes no push registration when the token is expired", async () => {
      const user = await makeUser();
      const token = await requestAndGetToken(user.email);
      await pool.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [
        user.id,
      ]);
      const registration = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: null,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/expired-token",
        p256dh: "key",
        authSecret: "secret",
      });

      const err = await resetPasswordInTransaction(pool, { token, newPassword: "whatever-password" }).catch(
        (e: unknown) => e,
      );
      expect((err as PasswordResetTokenError).reason).toBe("expired");

      const [row] = await listPushSubscriptionsForUser(pool, user.id);
      expect(row!.id).toBe(registration.id);
      expect(row!.revokedAt).toBeNull();
    });

    it("revokes no push registration when the newPassword is too short", async () => {
      const user = await makeUser();
      const token = await requestAndGetToken(user.email);
      const registration = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: null,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/short-password",
        p256dh: "key",
        authSecret: "secret",
      });

      const err = await resetPasswordInTransaction(pool, { token, newPassword: "1234567" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);

      const [row] = await listPushSubscriptionsForUser(pool, user.id);
      expect(row!.id).toBe(registration.id);
      expect(row!.revokedAt).toBeNull();
    });

    it("restores push registrations and the password when the reset transaction rolls back after the revocation", async () => {
      const user = await makeUser();
      const registration = await registerPushSubscription(pool, {
        userId: user.id,
        sessionId: null,
        channel: "web_push",
        platform: "web",
        endpoint: "https://push.example/rollback",
        p256dh: "key",
        authSecret: "secret",
      });
      const token = await requestAndGetToken(user.email);

      // Throw after resetPassword, inside the test's own transaction, so the whole reset rolls back.
      const err = await withTransaction(pool, async (client) => {
        await resetPassword(client, { token, newPassword: "a-brand-new-password" });
        throw new Error("forced rollback");
      }).catch((e: unknown) => e);
      expect((err as Error).message).toBe("forced rollback");

      const [row] = await listPushSubscriptionsForUser(pool, user.id);
      expect(row!.id).toBe(registration.id);
      expect(row!.revokedAt).toBeNull();

      const unchanged = await getUserByEmail(pool, user.email);
      expect(await verifyPassword(unchanged!.passwordHash, OLD_PASSWORD)).toBe(true);
    });
  });

  describe("a suspended account (issue #1041)", () => {
    async function activeUserInOwnTenant() {
      const tenantId = await createTestTenant(pool);
      const user = await createUser(pool, {
        email: "tenant-user@example.com",
        passwordHash: await hashPassword(OLD_PASSWORD),
        tenantId,
      });
      return { user, tenantId };
    }

    function suspend(tenantId: string): Promise<unknown> {
      return withTransaction(pool, (client) => transitionTenantStatus(client, tenantId, ["active"], "suspended"));
    }

    it("treats a reset request like an unknown email: no mail and no token row", async () => {
      const { user, tenantId } = await activeUserInOwnTenant();
      await suspend(tenantId);
      const mailer = fakeMailer();

      await expect(
        requestPasswordReset(pool, mailer, { email: user.email, appBaseUrl: APP_BASE_URL }),
      ).resolves.toBeUndefined();

      expect(mailer.sent).toHaveLength(0);
      const { rows } = await pool.query<{ count: string }>(
        "SELECT count(*) FROM password_reset_tokens WHERE user_id = $1",
        [user.id],
      );
      expect(Number(rows[0]!.count)).toBe(0);
    });

    it("refuses a token issued before the suspension as invalid and leaves it unconsumed with the password unchanged", async () => {
      const { user, tenantId } = await activeUserInOwnTenant();
      const mailer = fakeMailer();
      await requestPasswordReset(pool, mailer, { email: user.email, appBaseUrl: APP_BASE_URL });
      const token = tokenFromUrl(mailer.sent[0]!.resetUrl);
      await suspend(tenantId);
      const before = await getUserByEmail(pool, user.email);

      const failure = await resetPasswordInTransaction(pool, { token, newPassword: "a-brand-new-password" }).then(
        () => null,
        (err: unknown) => err,
      );

      expect(failure).toBeInstanceOf(PasswordResetTokenError);
      expect((failure as PasswordResetTokenError).reason).toBe("invalid");
      const { rows } = await pool.query<{ consumed_at: Date | null }>(
        "SELECT consumed_at FROM password_reset_tokens WHERE token_hash = $1",
        [hashToken(token)],
      );
      expect(rows[0]!.consumed_at).toBeNull();
      const after = await getUserByEmail(pool, user.email);
      expect(after!.passwordHash).toBe(before!.passwordHash);
    });

    it("refuses a token whose consumption waits on an uncommitted suspension of the user", async () => {
      const admin = await createUser(pool, {
        email: "admin@example.com",
        passwordHash: await hashPassword(OLD_PASSWORD),
        tenantId: getTenantZeroId(),
        role: "admin",
      });
      const { user } = await activeUserInOwnTenant();
      const mailer = fakeMailer();
      await requestPasswordReset(pool, mailer, { email: user.email, appBaseUrl: APP_BASE_URL });
      const token = tokenFromUrl(mailer.sent[0]!.resetUrl);
      const before = await getUserByEmail(pool, user.email);
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

      const attempt = resetPasswordInTransaction(pool, { token, newPassword: "a-brand-new-password" }).then(
        () => null,
        (err: unknown) => err,
      );
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

      const failure = await attempt;
      expect(failure).toBeInstanceOf(PasswordResetTokenError);
      expect((failure as PasswordResetTokenError).reason).toBe("invalid");
      const { rows } = await pool.query<{ consumed_at: Date | null }>(
        "SELECT consumed_at FROM password_reset_tokens WHERE token_hash = $1",
        [hashToken(token)],
      );
      expect(rows[0]!.consumed_at).toBeNull();
      const after = await getUserByEmail(pool, user.email);
      expect(after!.passwordHash).toBe(before!.passwordHash);
    });
  });
});
