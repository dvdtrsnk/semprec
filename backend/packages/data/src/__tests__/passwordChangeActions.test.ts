import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { createRuntimeRolePool, getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createTestTenant } from "../testSupport/tenantFixtures.js";
import { login, verifySessionToken } from "../auth/authActions.js";
import { getFailureStreak, recordLoginAttempt } from "../auth/loginAttemptsStore.js";
import { LOCKOUT_THRESHOLD } from "../auth/loginLockout.js";
import { changePassword, type ChangePasswordInput } from "../auth/passwordChangeActions.js";
import { hashPassword } from "../auth/passwordHash.js";
import { requestPasswordReset, resetPassword } from "../auth/passwordResetActions.js";
import type { PasswordResetMailer, SendPasswordResetEmailInput } from "../auth/passwordResetMail.js";
import {
  consumeAllPasswordResetTokensForUser,
  consumePasswordResetToken,
  consumeUnlockedPasswordResetTokensForUser,
  createPasswordResetToken,
  getPasswordResetTokenByHash,
} from "../auth/passwordResetStore.js";
import { isSessionActive } from "../auth/sessionsStore.js";
import { generateOpaqueToken } from "../auth/token.js";
import { createUser, getUserById, updateUserPasswordHash } from "../auth/usersStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, PasswordResetTokenError, UnauthorizedError, ValidationError } from "../errors.js";
import { listPushSubscriptionsForUser, upsertApnsSubscription } from "../push/pushSubscriptionsStore.js";
import { suspendAccount } from "../tenancy/accountsAdminStore.js";
import { ReauthenticationFailedError } from "../tenancy/deleteAccount.js";
import { lockUserTenantBinding } from "../tenancy/tenantsStore.js";

// `afterVerify` runs right after a real password verification, so a test can commit a concurrent change, or
// hold two calls, in the gap between `changePassword`'s check and its transaction. `afterConsume` runs right
// after `resetPassword` consumed its token, while that transaction still holds the token row. `afterCreate`
// runs right after a reset token was inserted, so a test can hold `requestPasswordReset` before its commit.
const hooks = vi.hoisted(() => ({
  verifyCalls: 0,
  afterVerify: null as null | (() => Promise<void>),
  afterConsume: null as null | (() => Promise<void>),
  afterCreate: null as null | (() => Promise<void>),
}));
vi.mock("../auth/passwordHash.js", async (importActual) => {
  const actual = await importActual<typeof import("../auth/passwordHash.js")>();
  return {
    ...actual,
    verifyPassword: async (...args: Parameters<typeof actual.verifyPassword>) => {
      hooks.verifyCalls += 1;
      const ok = await actual.verifyPassword(...args);
      await hooks.afterVerify?.();
      return ok;
    },
  };
});
vi.mock("../auth/passwordResetStore.js", async (importActual) => {
  const actual = await importActual<typeof import("../auth/passwordResetStore.js")>();
  return {
    ...actual,
    consumePasswordResetToken: async (...args: Parameters<typeof actual.consumePasswordResetToken>) => {
      const consumed = await actual.consumePasswordResetToken(...args);
      await hooks.afterConsume?.();
      return consumed;
    },
    createPasswordResetToken: async (...args: Parameters<typeof actual.createPasswordResetToken>) => {
      const created = await actual.createPasswordResetToken(...args);
      await hooks.afterCreate?.();
      return created;
    },
  };
});

const PASSWORD = "s3cret-password";
const NEW_PASSWORD = "a-brand-new-password";
const IP = "10.1.2.3";
const APP_BASE_URL = "https://app.example.test";

interface Account {
  userId: string;
  email: string;
}

interface SignedIn {
  token: string;
  sessionId: string;
}

interface IssuedToken {
  token: string;
  tokenHash: string;
}

let adminPool: Pool;
let pool: Pool;

async function makeAccount(): Promise<Account> {
  const tenantId = await createTestTenant(adminPool);
  const email = `${randomUUID()}@example.test`;
  const user = await createUser(adminPool, { email, passwordHash: await hashPassword(PASSWORD), tenantId });
  return { userId: user.id, email };
}

async function signIn(account: Account, password = PASSWORD, ip = IP): Promise<SignedIn> {
  const result = await login(adminPool, { email: account.email, password, platform: "ios", ip });
  return { token: result.token, sessionId: result.session.id };
}

/** Calls `changePassword` on the runtime-role pool in the system scope the auth listener runs in. */
function change(account: Account, sessionId: string, overrides: Partial<ChangePasswordInput> = {}): Promise<void> {
  return runAsSystem("passwordChangeActions.test", () =>
    changePassword(pool, {
      userId: account.userId,
      sessionId,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      ip: IP,
      ...overrides,
    }),
  );
}

async function passwordHashOf(userId: string): Promise<string> {
  const user = await getUserById(adminPool, userId);
  if (!user) throw new Error(`no user ${userId}`);
  return user.passwordHash;
}

/** The recorded attempts of `email`, oldest first. */
async function attemptsOf(email: string): Promise<Array<{ ip: string; succeeded: boolean }>> {
  const { rows } = await adminPool.query<{ ip: string; succeeded: boolean }>(
    "SELECT host(ip) AS ip, succeeded FROM login_attempts WHERE email = $1 ORDER BY attempted_at, id",
    [email],
  );
  return rows;
}

async function failedAttemptsOf(email: string): Promise<string[]> {
  return (await attemptsOf(email)).filter((attempt) => !attempt.succeeded).map((attempt) => attempt.ip);
}

async function issueResetToken(
  userId: string,
  expiresAt = new Date(Date.now() + 30 * 60 * 1000),
): Promise<IssuedToken> {
  const { token, tokenHash } = generateOpaqueToken();
  await createPasswordResetToken(adminPool, { userId, tokenHash, expiresAt });
  return { token, tokenHash };
}

async function consumedAtOf(tokenHash: string): Promise<string | null> {
  const row = await getPasswordResetTokenByHash(adminPool, tokenHash);
  if (!row) throw new Error("reset token not found");
  return row.consumedAt;
}

function consumeResetLink(token: string, newPassword = "reset-new-password"): Promise<void> {
  return withTransaction(adminPool, (client) => resetPassword(client, { token, newPassword }));
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

/** The statement with which `changePassword` locks the user row. */
const USER_ROW_LOCK = "SELECT password_hash FROM users";

/** Resolves once exactly `count` backends wait for a lock in a statement that starts with `statementStart`. */
async function waitingOnLock(statementStart: string, count = 1): Promise<void> {
  await vi.waitFor(
    async () => {
      const { rows } = await adminPool.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND starts_with(query, $1)`,
        [statementStart],
      );
      expect(rows[0]?.waiting).toBe(count);
    },
    { timeout: 10_000, interval: 50 },
  );
}

/** A promise a test resolves by hand, to hold a concurrent call at a known point or to learn that it got there. */
function signal(): { reached: Promise<void>; mark: () => void } {
  let mark!: () => void;
  const reached = new Promise<void>((resolve) => {
    mark = resolve;
  });
  return { reached, mark };
}

/** An admin of tenant zero, the actor of a suspension. */
async function makeAdmin(): Promise<Account> {
  const email = `${randomUUID()}@example.test`;
  const user = await createUser(adminPool, {
    email,
    passwordHash: await hashPassword(PASSWORD),
    tenantId: getTenantZeroId(),
    role: "admin",
  });
  return { userId: user.id, email };
}

/**
 * Holds the user row `FOR KEY SHARE` in an open transaction, as a login or a reset request does while it runs.
 * A change that reaches its user-row lock meanwhile waits there until `release` has resolved.
 */
async function holdUserRow(userId: string): Promise<{ release: () => Promise<void> }> {
  const locked = signal();
  const released = signal();
  const holding = withTransaction(adminPool, async (client) => {
    await lockUserTenantBinding(client, userId);
    locked.mark();
    await released.reached;
  });
  // Awaited by `release`; observed here too, so an early failure is never an unhandled rejection.
  holding.catch(() => undefined);
  await within(Promise.race([locked.reached, holding]), 10_000, "The key-share lock on the user row");
  return {
    release: async () => {
      released.mark();
      await holding;
    },
  };
}

async function registration(userId: string, sessionId: string): Promise<string> {
  const row = await upsertApnsSubscription(adminPool, {
    userId,
    sessionId,
    platform: "ios",
    deviceToken: randomUUID(),
    apnsEnvironment: "sandbox",
  });
  return row.id;
}

async function revokedRegistrations(userId: string): Promise<string[]> {
  const rows = await listPushSubscriptionsForUser(adminPool, userId);
  return rows.filter((row) => row.revokedAt !== null).map((row) => row.id);
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

describe("password change (issue #1701)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    hooks.verifyCalls = 0;
  });

  afterEach(() => {
    hooks.afterVerify = null;
    hooks.afterConsume = null;
    hooks.afterCreate = null;
  });

  describe("changePassword", () => {
    it("writes the new hash, keeps the calling session with its push registration and revokes the user's other sessions with theirs, leaving another user alone", async () => {
      const other = await makeAccount();
      const otherSession = await signIn(other);
      const otherRegistration = await registration(other.userId, otherSession.sessionId);
      const otherHash = await passwordHashOf(other.userId);
      const account = await makeAccount();
      const calling = await signIn(account);
      const others = [await signIn(account), await signIn(account)];
      const callingRegistration = await registration(account.userId, calling.sessionId);
      const revokedWithSessions = [
        await registration(account.userId, others[0]!.sessionId),
        await registration(account.userId, others[1]!.sessionId),
      ];

      await change(account, calling.sessionId);

      await expect(signIn(account, PASSWORD)).rejects.toBeInstanceOf(UnauthorizedError);
      const withNewPassword = await signIn(account, NEW_PASSWORD);
      expect(await isSessionActive(adminPool, withNewPassword.sessionId)).toBe(true);
      const identity = await verifySessionToken(adminPool, calling.token);
      expect(identity.session.id).toBe(calling.sessionId);
      for (const session of others) {
        await expect(verifySessionToken(adminPool, session.token)).rejects.toBeInstanceOf(UnauthorizedError);
      }
      // The calling session's registration is not among the revoked ones.
      expect(callingRegistration).toEqual(expect.any(String));
      expect((await revokedRegistrations(account.userId)).sort()).toEqual([...revokedWithSessions].sort());

      expect(await passwordHashOf(other.userId)).toBe(otherHash);
      expect(await isSessionActive(adminPool, otherSession.sessionId)).toBe(true);
      expect(otherRegistration).toEqual(expect.any(String));
      expect(await revokedRegistrations(other.userId)).toEqual([]);
    });

    it("consumes every unconsumed reset token of the user and none of another user's, so a link issued before the change answers consumed", async () => {
      const other = await makeAccount();
      const otherToken = await issueResetToken(other.userId);
      const account = await makeAccount();
      const calling = await signIn(account);
      const issued = [await issueResetToken(account.userId), await issueResetToken(account.userId)];

      await change(account, calling.sessionId);

      for (const token of issued) {
        expect(await consumedAtOf(token.tokenHash)).toEqual(expect.any(String));
        const refused = await consumeResetLink(token.token).catch((err: unknown) => err);
        expect(refused).toBeInstanceOf(PasswordResetTokenError);
        expect(refused).toMatchObject({ status: 400, code: "password_reset_token_consumed" });
      }
      expect(await consumedAtOf(otherToken.tokenHash)).toBeNull();
      // The change still stands: the refused links did not replace the new password.
      expect((await signIn(account, NEW_PASSWORD)).sessionId).toEqual(expect.any(String));
    });

    it("refuses a wrong current password with 403 reauthentication_failed, records one failed attempt for (email, ip) and changes nothing", async () => {
      const account = await makeAccount();
      const calling = await signIn(account);
      const second = await signIn(account);
      const token = await issueResetToken(account.userId);
      const hashBefore = await passwordHashOf(account.userId);

      const err = await change(account, calling.sessionId, { currentPassword: "wrong-password" }).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(ReauthenticationFailedError);
      expect(err).toMatchObject({ status: 403, code: "reauthentication_failed" });
      expect(await failedAttemptsOf(account.email)).toEqual([IP]);
      expect(await passwordHashOf(account.userId)).toBe(hashBefore);
      expect(await isSessionActive(adminPool, calling.sessionId)).toBe(true);
      expect(await isSessionActive(adminPool, second.sessionId)).toBe(true);
      expect(await consumedAtOf(token.tokenHash)).toBeNull();
    });

    it("does not verify the password while the email+IP pair is locked out, refuses the correct one and records that attempt too", async () => {
      const account = await makeAccount();
      const calling = await signIn(account);
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await recordLoginAttempt(adminPool, { email: account.email, ip: IP, succeeded: false });
      }
      const hashBefore = await passwordHashOf(account.userId);
      hooks.verifyCalls = 0;

      await expect(change(account, calling.sessionId)).rejects.toBeInstanceOf(ReauthenticationFailedError);

      expect(hooks.verifyCalls).toBe(0);
      expect(await failedAttemptsOf(account.email)).toHaveLength(LOCKOUT_THRESHOLD + 1);
      expect(await passwordHashOf(account.userId)).toBe(hashBefore);
    });

    it("locks login out with its own failed attempts: after LOCKOUT_THRESHOLD wrong current passwords the correct password cannot log in from that address", async () => {
      const account = await makeAccount();
      const calling = await signIn(account);
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await expect(change(account, calling.sessionId, { currentPassword: "wrong-password" })).rejects.toBeInstanceOf(
          ReauthenticationFailedError,
        );
      }

      await expect(signIn(account)).rejects.toBeInstanceOf(UnauthorizedError);
      // The calling session is not a casualty of the failed attempts.
      expect(await isSessionActive(adminPool, calling.sessionId)).toBe(true);
    });

    it("does not lock out another address of the same email", async () => {
      const account = await makeAccount();
      const calling = await signIn(account);
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await recordLoginAttempt(adminPool, { email: account.email, ip: IP, succeeded: false });
      }

      await change(account, calling.sessionId, { ip: "10.9.9.9" });

      expect((await signIn(account, NEW_PASSWORD, "10.9.9.9")).sessionId).toEqual(expect.any(String));
    });

    it("verifies again once the lockout of the pair has elapsed", async () => {
      const account = await makeAccount();
      const calling = await signIn(account);
      for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
        await recordLoginAttempt(adminPool, { email: account.email, ip: IP, succeeded: false });
      }
      // Raw SQL because no production write backdates an attempt: the lockout of a streak at the threshold
      // lasts 30 seconds, and these failures are now an hour old.
      await adminPool.query(
        "UPDATE login_attempts SET attempted_at = now() - interval '1 hour' WHERE email = $1 AND succeeded = false",
        [account.email],
      );

      await change(account, calling.sessionId);

      expect((await signIn(account, NEW_PASSWORD)).sessionId).toEqual(expect.any(String));
    });

    it("records a successful attempt that ends the failure streak of the pair", async () => {
      const account = await makeAccount();
      // Created without `login`, so the only successful attempt below is the change's own.
      const sessionId = randomUUID();
      for (let i = 0; i < LOCKOUT_THRESHOLD - 1; i++) {
        await expect(change(account, sessionId, { currentPassword: "wrong-password" })).rejects.toBeInstanceOf(
          ReauthenticationFailedError,
        );
      }
      expect((await getFailureStreak(adminPool, account.email, IP)).count).toBe(LOCKOUT_THRESHOLD - 1);

      await change(account, sessionId);

      expect(await attemptsOf(account.email)).toEqual([
        ...Array.from({ length: LOCKOUT_THRESHOLD - 1 }, () => ({ ip: IP, succeeded: false })),
        { ip: IP, succeeded: true },
      ]);
      expect(await getFailureStreak(adminPool, account.email, IP)).toEqual({ count: 0, lastFailedAt: null });
    });

    it("refuses a newPassword of 7 characters with validation_failed naming the field, before any query", async () => {
      const account = await makeAccount();
      const calling = await signIn(account);
      const hashBefore = await passwordHashOf(account.userId);
      const attemptsBefore = await attemptsOf(account.email);
      hooks.verifyCalls = 0;
      const querySpy = vi.spyOn(pool, "query");
      const connectSpy = vi.spyOn(pool, "connect");
      try {
        const err = await change(account, calling.sessionId, { newPassword: "1234567" }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ValidationError);
        expect(err).toMatchObject({ status: 400, code: "validation_failed", details: { field: "newPassword" } });
        expect(querySpy).not.toHaveBeenCalled();
        expect(connectSpy).not.toHaveBeenCalled();
      } finally {
        querySpy.mockRestore();
        connectSpy.mockRestore();
      }
      expect(hooks.verifyCalls).toBe(0);
      expect(await attemptsOf(account.email)).toEqual(attemptsBefore);
      expect(await passwordHashOf(account.userId)).toBe(hashBefore);
    });

    it("accepts a newPassword of exactly 8 characters", async () => {
      const account = await makeAccount();
      const calling = await signIn(account);

      await change(account, calling.sessionId, { newPassword: "12345678" });

      expect((await signIn(account, "12345678")).sessionId).toEqual(expect.any(String));
    });

    it("answers NotFoundError for an unknown user and records no attempt", async () => {
      const unknown = { userId: randomUUID(), email: "nobody@example.test" };

      await expect(change(unknown, randomUUID())).rejects.toBeInstanceOf(NotFoundError);

      expect(hooks.verifyCalls).toBe(0);
      const { rows } = await adminPool.query<{ n: number }>("SELECT count(*)::int AS n FROM login_attempts");
      expect(rows[0]?.n).toBe(0);
    });

    it("answers NotFoundError when the user row is gone by the time it is locked", async () => {
      const account = await makeAccount();
      hooks.afterVerify = async () => {
        // Raw SQL because only the tenant purge deletes a user; the account has no session, token or attempt yet.
        await adminPool.query("DELETE FROM users WHERE id = $1", [account.userId]);
      };

      await expect(change(account, randomUUID())).rejects.toBeInstanceOf(NotFoundError);

      // Neither a failed nor a successful attempt: the refusal came from the transaction, which rolled back.
      expect(await attemptsOf(account.email)).toEqual([]);
    });

    it("refuses a change whose verified hash was replaced before the lock, records no attempt and rolls back the token consumption", async () => {
      const account = await makeAccount();
      const calling = await signIn(account);
      const second = await signIn(account);
      const token = await issueResetToken(account.userId);
      const replacement = await hashPassword("replaced-meanwhile");
      const attemptsBefore = await attemptsOf(account.email);
      hooks.afterVerify = async () => {
        await updateUserPasswordHash(adminPool, account.userId, replacement);
      };

      const err = await change(account, calling.sessionId).catch((e: unknown) => e);
      hooks.afterVerify = null;

      expect(err).toBeInstanceOf(ReauthenticationFailedError);
      expect(await passwordHashOf(account.userId)).toBe(replacement);
      expect(await attemptsOf(account.email)).toEqual(attemptsBefore);
      expect(await isSessionActive(adminPool, calling.sessionId)).toBe(true);
      expect(await isSessionActive(adminPool, second.sessionId)).toBe(true);
      expect(await consumedAtOf(token.tokenHash)).toBeNull();
    });

    it("lets exactly one of two changes that verified the same current password succeed and refuses the other", async () => {
      const account = await makeAccount();
      const callers = [
        { session: await signIn(account), newPassword: "first-new-password" },
        { session: await signIn(account), newPassword: "second-new-password" },
      ];
      const attemptsBefore = await attemptsOf(account.email);
      // Both calls finish their verification before either goes on to its transaction.
      let verified = 0;
      let markBothVerified!: () => void;
      const bothVerified = new Promise<void>((resolve) => {
        markBothVerified = resolve;
      });
      hooks.afterVerify = async () => {
        verified += 1;
        if (verified === 2) markBothVerified();
        await within(bothVerified, 10_000, "The second verification");
      };

      const outcomes = await Promise.allSettled(
        callers.map((caller) => change(account, caller.session.sessionId, { newPassword: caller.newPassword })),
      );
      hooks.afterVerify = null;

      expect(verified).toBe(2);
      const refusals: unknown[] = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason as unknown] : [],
      );
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toBeInstanceOf(ReauthenticationFailedError);
      const winner = callers.find((_caller, index) => outcomes[index]?.status === "fulfilled");
      const loser = callers.find((_caller, index) => outcomes[index]?.status === "rejected");
      if (!winner || !loser) throw new Error("expected one fulfilled and one rejected change");
      // The refused call recorded nothing: one more attempt than before, the winner's success.
      expect(await attemptsOf(account.email)).toEqual([...attemptsBefore, { ip: IP, succeeded: true }]);
      expect(await isSessionActive(adminPool, winner.session.sessionId)).toBe(true);
      expect(await isSessionActive(adminPool, loser.session.sessionId)).toBe(false);
      await expect(signIn(account, loser.newPassword)).rejects.toBeInstanceOf(UnauthorizedError);
      expect((await signIn(account, winner.newPassword)).sessionId).toEqual(expect.any(String));
    });

    it("waits for a reset that holds its token row and is then refused, instead of deadlocking with it", async () => {
      const account = await makeAccount();
      const calling = await signIn(account);
      const link = await issueResetToken(account.userId);
      let markConsumed!: () => void;
      const tokenConsumed = new Promise<void>((resolve) => {
        markConsumed = resolve;
      });
      let releaseReset!: () => void;
      const resetHeld = new Promise<void>((resolve) => {
        releaseReset = resolve;
      });
      hooks.afterConsume = async () => {
        markConsumed();
        await resetHeld;
      };
      // The reset consumed its token and has not yet locked the user row.
      const resetting = consumeResetLink(link.token, "reset-new-password");
      // Awaited below; observed here too, so an early failure is never an unhandled rejection.
      resetting.catch(() => undefined);
      await within(tokenConsumed, 10_000, "The reset's token consumption");

      const changing = change(account, calling.sessionId);
      changing.catch(() => undefined);
      try {
        await vi.waitFor(
          async () => {
            const { rows } = await adminPool.query<{ waiting: number }>(
              `SELECT count(*)::int AS waiting FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock'
                 AND query LIKE 'UPDATE password_reset_tokens%'`,
            );
            expect(rows[0]?.waiting).toBe(1);
          },
          { timeout: 10_000, interval: 50 },
        );
      } finally {
        releaseReset();
      }

      await expect(within(resetting, 10_000, "The reset")).resolves.toBeUndefined();
      await expect(within(changing, 10_000, "The password change")).rejects.toBeInstanceOf(ReauthenticationFailedError);
      hooks.afterConsume = null;
      expect((await signIn(account, "reset-new-password")).sessionId).toEqual(expect.any(String));
      await expect(signIn(account, NEW_PASSWORD)).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it("refuses with UnauthorizedError when a suspension of the account commits between the verification and the transaction, and writes nothing", async () => {
      const admin = await makeAdmin();
      const account = await makeAccount();
      const calling = await signIn(account);
      const token = await issueResetToken(account.userId);
      const hashBefore = await passwordHashOf(account.userId);
      const attemptsBefore = await attemptsOf(account.email);
      hooks.afterVerify = async () => {
        await withTransaction(adminPool, (client) =>
          suspendAccount(client, { actorUserId: admin.userId, targetUserId: account.userId }),
        );
      };

      const err = await change(account, calling.sessionId).catch((e: unknown) => e);
      hooks.afterVerify = null;

      expect(err).toBeInstanceOf(UnauthorizedError);
      expect(err).toMatchObject({ status: 401, code: "unauthorized" });
      // The suspended tenant got no new credential, and the refusal rolled the token marking back.
      expect(await passwordHashOf(account.userId)).toBe(hashBefore);
      expect(await attemptsOf(account.email)).toEqual(attemptsBefore);
      expect(await consumedAtOf(token.tokenHash)).toBeNull();
    });

    it("waits at its user-row lock for an uncommitted suspension of the account and is refused once it commits", async () => {
      const admin = await makeAdmin();
      const account = await makeAccount();
      const calling = await signIn(account);
      const hashBefore = await passwordHashOf(account.userId);
      const attemptsBefore = await attemptsOf(account.email);
      const suspended = signal();
      const released = signal();
      const suspending = withTransaction(adminPool, async (client) => {
        await suspendAccount(client, { actorUserId: admin.userId, targetUserId: account.userId });
        suspended.mark();
        await released.reached;
      });
      // Awaited below; observed here too, so an early failure is never an unhandled rejection.
      suspending.catch(() => undefined);
      await within(Promise.race([suspended.reached, suspending]), 10_000, "The suspension");

      // The unlocked reads before the transaction still see an active tenant.
      const changing = change(account, calling.sessionId);
      changing.catch(() => undefined);
      try {
        await waitingOnLock(USER_ROW_LOCK);
      } finally {
        released.mark();
      }

      await within(suspending, 10_000, "The suspension's commit");
      const err = await within(changing, 10_000, "The password change").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedError);
      expect(await passwordHashOf(account.userId)).toBe(hashBefore);
      expect(await attemptsOf(account.email)).toEqual(attemptsBefore);
    });

    it("consumes a reset token whose request commits after the first marking, while the change waits for the user row", async () => {
      const account = await makeAccount();
      const calling = await signIn(account);
      const mailer = fakeMailer();
      const inserted = signal();
      const released = signal();
      hooks.afterCreate = async () => {
        hooks.afterCreate = null;
        inserted.mark();
        await released.reached;
      };
      // The request inserted its token and holds the user row FOR KEY SHARE; it has not committed.
      const requesting = requestPasswordReset(adminPool, mailer, { email: account.email, appBaseUrl: APP_BASE_URL });
      // Awaited below; observed here too, so an early failure is never an unhandled rejection.
      requesting.catch(() => undefined);
      await within(Promise.race([inserted.reached, requesting]), 10_000, "The reset request's token insert");

      const changing = change(account, calling.sessionId);
      changing.catch(() => undefined);
      try {
        // The change's first marking ran without seeing the uncommitted token; its user-row lock waits for the request.
        await waitingOnLock(USER_ROW_LOCK);
      } finally {
        released.mark();
      }

      await expect(within(requesting, 10_000, "The reset request")).resolves.toBeUndefined();
      await expect(within(changing, 10_000, "The password change")).resolves.toBeUndefined();
      const mail = mailer.sent[0];
      if (!mail || mailer.sent.length !== 1) throw new Error("expected exactly one reset mail");
      const refused = await consumeResetLink(tokenFromUrl(mail.resetUrl)).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(PasswordResetTokenError);
      expect(refused).toMatchObject({ status: 400, code: "password_reset_token_consumed" });
      // The refused link did not replace the new password, and the calling session is still the user's.
      expect((await signIn(account, NEW_PASSWORD)).sessionId).toEqual(expect.any(String));
      expect(await isSessionActive(adminPool, calling.sessionId)).toBe(true);
    });

    it("is refused, without waiting, while a reset holds a token the first marking could not see, and leaves that reset to finish", async () => {
      const account = await makeAccount();
      const calling = await signIn(account);
      const earlier = await issueResetToken(account.userId);
      const hashBefore = await passwordHashOf(account.userId);
      const attemptsBefore = await attemptsOf(account.email);
      const userRow = await holdUserRow(account.userId);
      const consumed = signal();
      const released = signal();
      const changing = change(account, calling.sessionId);
      // Awaited below; observed here too, so an early failure is never an unhandled rejection.
      changing.catch(() => undefined);
      let resetting: Promise<void> | undefined;
      try {
        // The change marked `earlier` and waits for the user row.
        await waitingOnLock(USER_ROW_LOCK);
        // Committed after the change's first marking, then taken by a reset that has not yet locked the user row.
        const link = await issueResetToken(account.userId);
        hooks.afterConsume = async () => {
          hooks.afterConsume = null;
          consumed.mark();
          await released.reached;
        };
        resetting = consumeResetLink(link.token, "reset-new-password");
        resetting.catch(() => undefined);
        await within(Promise.race([consumed.reached, resetting]), 10_000, "The reset's token consumption");
        await userRow.release();

        // Refused while the reset is still held: the change did not wait for the token row.
        const err = await within(changing, 10_000, "The password change").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ReauthenticationFailedError);
        expect(await passwordHashOf(account.userId)).toBe(hashBefore);
        expect(await attemptsOf(account.email)).toEqual(attemptsBefore);
        expect(await isSessionActive(adminPool, calling.sessionId)).toBe(true);
        // The refusal rolled back the marking of the token the change did hold.
        expect(await consumedAtOf(earlier.tokenHash)).toBeNull();
      } finally {
        released.mark();
        await userRow.release();
        await Promise.allSettled([changing, resetting]);
      }

      if (resetting === undefined) throw new Error("the reset was not started");
      await expect(resetting).resolves.toBeUndefined();
      expect((await signIn(account, "reset-new-password")).sessionId).toEqual(expect.any(String));
      await expect(signIn(account, NEW_PASSWORD)).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it("lets exactly one of two racing changes succeed and leaves no token usable when one of them holds a token the other could not mark", async () => {
      const account = await makeAccount();
      const callers = [
        { session: await signIn(account), newPassword: "first-new-password" },
        { session: await signIn(account), newPassword: "second-new-password" },
      ];
      const userRow = await holdUserRow(account.userId);
      const [first, second] = callers;
      if (!first || !second) throw new Error("expected two callers");
      const changes: Array<Promise<void>> = [];
      let link: IssuedToken | undefined;
      try {
        // The first change runs its first marking before the token exists and waits for the user row.
        const firstChange = change(account, first.session.sessionId, { newPassword: first.newPassword });
        // Awaited below; observed here too, so an early failure is never an unhandled rejection.
        firstChange.catch(() => undefined);
        changes.push(firstChange);
        await waitingOnLock(USER_ROW_LOCK);
        link = await issueResetToken(account.userId);
        // The second change marks that token in its first marking and then waits for the user row too.
        const secondChange = change(account, second.session.sessionId, { newPassword: second.newPassword });
        secondChange.catch(() => undefined);
        changes.push(secondChange);
        await waitingOnLock(USER_ROW_LOCK, 2);
      } finally {
        await userRow.release();
      }

      const outcomes = await within(Promise.allSettled(changes), 10_000, "The two password changes");
      const refusals: unknown[] = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason as unknown] : [],
      );
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toBeInstanceOf(ReauthenticationFailedError);
      const winner = callers.find((_caller, index) => outcomes[index]?.status === "fulfilled");
      const loser = callers.find((_caller, index) => outcomes[index]?.status === "rejected");
      if (!winner || !loser || !link) throw new Error("expected one fulfilled change, one rejected change and a token");
      // Whichever change committed, the token issued before it is consumed.
      expect(await consumedAtOf(link.tokenHash)).toEqual(expect.any(String));
      await expect(consumeResetLink(link.token)).rejects.toMatchObject({ code: "password_reset_token_consumed" });
      expect((await signIn(account, winner.newPassword)).sessionId).toEqual(expect.any(String));
      await expect(signIn(account, loser.newPassword)).rejects.toBeInstanceOf(UnauthorizedError);
    });
  });

  describe("consumeAllPasswordResetTokensForUser", () => {
    it("marks the user's unexpired and expired unconsumed tokens consumed and keeps an earlier consumption and another user's token", async () => {
      const other = await makeAccount();
      const otherToken = await issueResetToken(other.userId);
      const account = await makeAccount();
      const live = await issueResetToken(account.userId);
      const expired = await issueResetToken(account.userId, new Date(Date.now() - 60 * 1000));
      const alreadyConsumed = await issueResetToken(account.userId);
      await consumePasswordResetToken(adminPool, alreadyConsumed.tokenHash);
      const consumedEarlierAt = await consumedAtOf(alreadyConsumed.tokenHash);
      expect(consumedEarlierAt).toEqual(expect.any(String));

      const marked = await runAsSystem("passwordChangeActions.test", () =>
        withTransaction(pool, (client) => consumeAllPasswordResetTokensForUser(client, account.userId)),
      );

      expect(marked).toBe(2);
      expect(await consumedAtOf(live.tokenHash)).toEqual(expect.any(String));
      expect(await consumedAtOf(expired.tokenHash)).toEqual(expect.any(String));
      expect(await consumedAtOf(alreadyConsumed.tokenHash)).toBe(consumedEarlierAt);
      expect(await consumedAtOf(otherToken.tokenHash)).toBeNull();
      // An expired link reads as consumed afterwards, not as expired.
      await expect(consumeResetLink(expired.token)).rejects.toMatchObject({ code: "password_reset_token_consumed" });
    });

    it("marks nothing and returns 0 for a user without an unconsumed token", async () => {
      const account = await makeAccount();
      const other = await makeAccount();
      const otherToken = await issueResetToken(other.userId);

      const marked = await runAsSystem("passwordChangeActions.test", () =>
        consumeAllPasswordResetTokensForUser(pool, account.userId),
      );

      expect(marked).toBe(0);
      expect(await consumedAtOf(otherToken.tokenHash)).toBeNull();
    });
  });

  describe("consumeUnlockedPasswordResetTokensForUser", () => {
    function markUnlocked(userId: string): Promise<{ consumed: number; remaining: number }> {
      return runAsSystem("passwordChangeActions.test", () =>
        withTransaction(pool, (client) => consumeUnlockedPasswordResetTokensForUser(client, userId)),
      );
    }

    it("marks the user's unexpired and expired unconsumed tokens consumed, reports none remaining and keeps an earlier consumption and another user's token", async () => {
      const other = await makeAccount();
      const otherToken = await issueResetToken(other.userId);
      const account = await makeAccount();
      const live = await issueResetToken(account.userId);
      const expired = await issueResetToken(account.userId, new Date(Date.now() - 60 * 1000));
      const alreadyConsumed = await issueResetToken(account.userId);
      await consumePasswordResetToken(adminPool, alreadyConsumed.tokenHash);
      const consumedEarlierAt = await consumedAtOf(alreadyConsumed.tokenHash);
      expect(consumedEarlierAt).toEqual(expect.any(String));

      const result = await markUnlocked(account.userId);

      expect(result).toEqual({ consumed: 2, remaining: 0 });
      expect(await consumedAtOf(live.tokenHash)).toEqual(expect.any(String));
      expect(await consumedAtOf(expired.tokenHash)).toEqual(expect.any(String));
      expect(await consumedAtOf(alreadyConsumed.tokenHash)).toBe(consumedEarlierAt);
      expect(await consumedAtOf(otherToken.tokenHash)).toBeNull();
    });

    it("leaves a token whose row a reset holds, without waiting for it, and counts it as remaining", async () => {
      const account = await makeAccount();
      const free = await issueResetToken(account.userId);
      const held = await issueResetToken(account.userId);
      const consumed = signal();
      const released = signal();
      hooks.afterConsume = async () => {
        hooks.afterConsume = null;
        consumed.mark();
        await released.reached;
      };
      // The reset consumed `held` and has not committed, so it still holds that token row.
      const resetting = consumeResetLink(held.token);
      // Awaited below; observed here too, so an early failure is never an unhandled rejection.
      resetting.catch(() => undefined);
      try {
        await within(Promise.race([consumed.reached, resetting]), 10_000, "The reset's token consumption");

        const result = await within(markUnlocked(account.userId), 10_000, "The marking");

        expect(result).toEqual({ consumed: 1, remaining: 1 });
        expect(await consumedAtOf(free.tokenHash)).toEqual(expect.any(String));
        // The reset has not committed: its token still reads as unconsumed.
        expect(await consumedAtOf(held.tokenHash)).toBeNull();
      } finally {
        released.mark();
        await Promise.allSettled([resetting]);
      }
      await expect(resetting).resolves.toBeUndefined();
    });

    it("marks nothing and reports none remaining for a user without an unconsumed token", async () => {
      const account = await makeAccount();
      const other = await makeAccount();
      const otherToken = await issueResetToken(other.userId);

      const result = await markUnlocked(account.userId);

      expect(result).toEqual({ consumed: 0, remaining: 0 });
      expect(await consumedAtOf(otherToken.tokenHash)).toBeNull();
    });
  });
});
