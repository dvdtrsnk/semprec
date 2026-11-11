import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, UnauthorizedError, ValidationError } from "../errors.js";
import { ReauthenticationFailedError } from "../tenancy/deleteAccount.js";
import { lockUserTenantBinding } from "../tenancy/tenantsStore.js";
import { MIN_PASSWORD_LENGTH, revokeOtherUserSessions } from "./authActions.js";
import { normalizeEmail } from "./emailNormalization.js";
import { getFailureStreak, recordLoginAttempt } from "./loginAttemptsStore.js";
import { lockoutDurationSeconds } from "./loginLockout.js";
import { hashPassword, verifyPassword } from "./passwordHash.js";
import {
  consumeAllPasswordResetTokensForUser,
  consumeUnlockedPasswordResetTokensForUser,
} from "./passwordResetStore.js";
import { getUserById, updateUserPasswordHash } from "./usersStore.js";

/** The user's password hash, read under a `FOR UPDATE` lock on the user row; `null` when the row is gone. */
async function lockPasswordHash(client: PoolClient, userId: string): Promise<string | null> {
  const { rows } = await client.query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = $1 FOR UPDATE",
    [userId],
  );
  return rows[0]?.password_hash ?? null;
}

export interface ChangePasswordInput {
  userId: string;
  /** The session the request is authenticated with: the one session of the user that stays valid. */
  sessionId: string;
  currentPassword: string;
  newPassword: string;
  ip: string;
}

/**
 * Changes a signed-in user's password after they re-enter the current one (issue #1701), modelled on
 * `deleteOwnAccount`. It reads the email+IP failure streak that `login` reads: a locked pair is not
 * verified, and a locked pair or a wrong `currentPassword` records a failed attempt on the pool
 * (auto-committed, so it survives the throw) and throws `ReauthenticationFailedError`.
 *
 * After a correct password, one transaction does the rest in this order. A refusal in it rolls all of
 * it back and records no attempt.
 *
 * 1. It marks the user's unconsumed reset tokens consumed. The transaction holds no other lock yet, so
 *    it can wait here for a `resetPassword` that holds its token row.
 * 2. It locks the user row `FOR UPDATE`. A row that is gone answers `NotFoundError`.
 * 3. It reads the tenant status again through `lockUserTenantBinding`. The request was authenticated
 *    before this transaction, and a suspension or deletion that committed since has revoked its session,
 *    so a tenant that is not `active` answers `UnauthorizedError` and gets no new password hash
 *    (docs/adr/2026-10-17-admin-membership-and-tenant-status-writes.md).
 * 4. A hash that differs from the one verified was replaced by a change or a reset that committed in
 *    between, so the verified credential is stale: `ReauthenticationFailedError`.
 * 5. It marks the tokens again, this time without waiting for a locked one. While the user row is held
 *    `FOR UPDATE` no reset request can commit a token, so this reaches every token committed since
 *    step 1. A token it has to leave is held by a reset that is consuming it or by another change: this
 *    change is refused with `ReauthenticationFailedError` and that transaction goes on.
 * 6. It writes the new Argon2id hash, revokes the user's other sessions and their push registrations
 *    through `revokeOtherUserSessions`, which keeps `sessionId`, and records a successful attempt, which
 *    ends the failure streak.
 *
 * When a change commits, every reset token of the user that was committed before it is therefore
 * consumed. The lock order and its reasons are recorded in
 * docs/adr/2026-11-10-password-change-marks-reset-tokens-before-and-under-the-user-row-lock.md.
 *
 * A `newPassword` shorter than `MIN_PASSWORD_LENGTH` is refused with a `ValidationError` before any
 * query. A `userId` without a user row answers `NotFoundError`.
 *
 * Takes a `Pool`, not a caller's transaction, for the reason `login` does: the failed attempt must
 * outlive the throw (docs/adr/2026-09-27-auto-committed-writes-for-records-that-must-survive-a-failure.md).
 */
export async function changePassword(pool: Pool, input: ChangePasswordInput): Promise<void> {
  if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`'newPassword' must be at least ${MIN_PASSWORD_LENGTH} characters`, {
      field: "newPassword",
    });
  }
  const user = await getUserById(pool, input.userId);
  if (!user) throw new NotFoundError("Account not found", { userId: input.userId });
  const email = normalizeEmail(user.email);

  const streak = await getFailureStreak(pool, email, input.ip);
  let locked = false;
  if (streak.lastFailedAt) {
    const lockedUntil = new Date(streak.lastFailedAt).getTime() + lockoutDurationSeconds(streak.count) * 1000;
    locked = Date.now() < lockedUntil;
  }
  // A locked pair skips verification, exactly as `login` does.
  const passwordOk = !locked && (await verifyPassword(user.passwordHash, input.currentPassword));
  if (locked || !passwordOk) {
    await recordLoginAttempt(pool, { email, ip: input.ip, succeeded: false });
    throw new ReauthenticationFailedError();
  }

  // Hashed before the transaction, so its row locks are not held for the duration of Argon2id.
  const newPasswordHash = await hashPassword(input.newPassword);
  await withTransaction(pool, async (client) => {
    // The first statement, so a reset that holds its token row is waited for while this transaction
    // holds no lock that reset could be waiting for.
    await consumeAllPasswordResetTokensForUser(client, input.userId);
    const lockedHash = await lockPasswordHash(client, input.userId);
    if (lockedHash === null) throw new NotFoundError("Account not found", { userId: input.userId });
    // Read again under lock: a suspension that committed after the request was authenticated is seen
    // here, and one that has not yet locked the user row waits for this commit. It follows the
    // `FOR UPDATE` above because two changes that each held the row `FOR KEY SHARE` first could not
    // both upgrade.
    const binding = await lockUserTenantBinding(client, input.userId);
    if (binding?.status !== "active") throw new UnauthorizedError();
    // The password was verified before this transaction. A change that committed in between replaced
    // the hash, so the verified credential is stale and the request is refused.
    if (lockedHash !== user.passwordHash) throw new ReauthenticationFailedError();
    // No reset request can commit a token while the user row is held, so this marks the ones committed
    // since the first marking. A token left over is locked by a reset or by another change that has
    // not ended and would be usable again if that transaction rolled back.
    const tokens = await consumeUnlockedPasswordResetTokensForUser(client, input.userId);
    if (tokens.remaining > 0) throw new ReauthenticationFailedError();
    await updateUserPasswordHash(client, input.userId, newPasswordHash);
    await revokeOtherUserSessions(client, input.userId, input.sessionId);
    await recordLoginAttempt(client, { email, ip: input.ip, succeeded: true });
  });
}
