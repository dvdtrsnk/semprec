import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { hashPassword, verifyPassword } from "../auth/passwordHash.js";
import { createUser, getUserByEmail } from "../auth/usersStore.js";
import { createSession, getActiveSessionByTokenHash } from "../auth/sessionsStore.js";
import { generateOpaqueToken, hashToken } from "../auth/token.js";
import {
  PASSWORD_RESET_MAX_REQUESTS_PER_WINDOW,
  requestPasswordReset,
  resetPassword,
} from "../auth/passwordResetActions.js";
import type { PasswordResetMailer, SendPasswordResetEmailInput } from "../auth/passwordResetMail.js";
import { PasswordResetTokenError } from "../errors.js";

let pool: Pool;

const OLD_PASSWORD = "s3cret-password";
const APP_BASE_URL = "https://app.example.test";

async function makeUser(email = "person@example.com") {
  return createUser(pool, { email, passwordHash: await hashPassword(OLD_PASSWORD) });
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
  const token = new URL(resetUrl).searchParams.get("token");
  if (!token) throw new Error(`expected a token in ${resetUrl}`);
  return token;
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
      expect(mailer.sent[0]!.resetUrl.startsWith(`${APP_BASE_URL}/reset-password?token=`)).toBe(true);
    });

    it("is a silent no-op for an unknown email — no mail sent, no error", async () => {
      const mailer = fakeMailer();

      await expect(
        requestPasswordReset(pool, mailer, { email: "nobody@example.com", appBaseUrl: APP_BASE_URL }),
      ).resolves.toBeUndefined();

      expect(mailer.sent).toHaveLength(0);
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

      await resetPassword(pool, { token, newPassword: "a-brand-new-password" });

      const updated = await getUserByEmail(pool, user.email);
      expect(updated).not.toBeNull();
      expect(await verifyPassword(updated!.passwordHash, "a-brand-new-password")).toBe(true);
      expect(await verifyPassword(updated!.passwordHash, OLD_PASSWORD)).toBe(false);
    });

    it("rejects a second consumption of the same token with a 'consumed' reason", async () => {
      const user = await makeUser();
      const token = await requestAndGetToken(user.email);

      await resetPassword(pool, { token, newPassword: "first-new-password" });

      const err = await resetPassword(pool, { token, newPassword: "second-new-password" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PasswordResetTokenError);
      expect((err as PasswordResetTokenError).reason).toBe("consumed");

      // The second, rejected attempt must not have overwritten the password the first attempt set.
      const updated = await getUserByEmail(pool, user.email);
      expect(await verifyPassword(updated!.passwordHash, "first-new-password")).toBe(true);
    });

    it("rejects a token that was never issued with an 'invalid' reason", async () => {
      const err = await resetPassword(pool, { token: "not-a-real-token", newPassword: "whatever-password" }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PasswordResetTokenError);
      expect((err as PasswordResetTokenError).reason).toBe("invalid");
    });

    it("rejects an expired token with an 'expired' reason", async () => {
      const user = await makeUser();
      const token = await requestAndGetToken(user.email);
      await pool.query(`UPDATE password_reset_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [
        user.id,
      ]);

      const err = await resetPassword(pool, { token, newPassword: "whatever-password" }).catch((e: unknown) => e);
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
      await resetPassword(pool, { token, newPassword: "a-brand-new-password" });

      expect(await getActiveSessionByTokenHash(pool, tokenHash)).toBeNull();
    });
  });
});
