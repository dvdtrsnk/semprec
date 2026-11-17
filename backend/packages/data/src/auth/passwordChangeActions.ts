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

/** `null` when the row is gone. */
async function lockPasswordHash(client: PoolClient, userId: string): Promise<string | null> {
  const { rows } = await client.query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = $1 FOR UPDATE",
    [userId],
  );
  return rows[0]?.password_hash ?? null;
}

export interface ChangePasswordInput {
  userId: string;
  /** The one session of the user that stays valid. */
  sessionId: string;
  currentPassword: string;
  newPassword: string;
  ip: string;
}

/**
 * Re-authenticates with the login lockout rules; a failed attempt is auto-committed on the pool so
 * it survives the throw (hence a `Pool`, not a caller transaction).
 *
 * The transaction's lock order matters: reset tokens are marked first (holding nothing a waiting
 * reset could need), then the user row `FOR UPDATE`, then the tenant re-check, then the tokens
 * again without waiting. On commit every reset token committed before the change is consumed. See
 * docs/architecture/tenancy-and-security.md#password-reset-and-change.
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
  const passwordOk = !locked && (await verifyPassword(user.passwordHash, input.currentPassword));
  if (locked || !passwordOk) {
    await recordLoginAttempt(pool, { email, ip: input.ip, succeeded: false });
    throw new ReauthenticationFailedError();
  }

  // Hashed outside the transaction so row locks are not held during Argon2id.
  const newPasswordHash = await hashPassword(input.newPassword);
  await withTransaction(pool, async (client) => {
    // First, while this transaction holds no lock a waiting reset could need.
    await consumeAllPasswordResetTokensForUser(client, input.userId);
    const lockedHash = await lockPasswordHash(client, input.userId);
    if (lockedHash === null) throw new NotFoundError("Account not found", { userId: input.userId });
    // After `FOR UPDATE`: two changes each holding `FOR KEY SHARE` first could not both upgrade.
    const binding = await lockUserTenantBinding(client, input.userId);
    if (binding?.status !== "active") throw new UnauthorizedError();
    // A change or reset committed since verification: the verified credential is stale.
    if (lockedHash !== user.passwordHash) throw new ReauthenticationFailedError();
    // No reset can commit a token while the user row is held. A leftover token is locked by another
    // transaction and would become usable again if that one rolled back, so refuse.
    const tokens = await consumeUnlockedPasswordResetTokensForUser(client, input.userId);
    if (tokens.remaining > 0) throw new ReauthenticationFailedError();
    await updateUserPasswordHash(client, input.userId, newPasswordHash);
    await revokeOtherUserSessions(client, input.userId, input.sessionId);
    await recordLoginAttempt(client, { email, ip: input.ip, succeeded: true });
  });
}
