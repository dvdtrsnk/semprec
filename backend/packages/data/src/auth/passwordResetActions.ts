import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { PasswordResetTokenError } from "../errors.js";
import { hashPassword } from "./passwordHash.js";
import { generateOpaqueToken, hashToken } from "./token.js";
import { getUserByEmail, updateUserPasswordHash } from "./usersStore.js";
import { revokeAllSessionsForUser } from "./sessionsStore.js";
import {
  consumePasswordResetToken,
  countRecentPasswordResetTokens,
  createPasswordResetToken,
  getPasswordResetTokenByHash,
} from "./passwordResetStore.js";
import { normalizeEmail } from "./emailNormalization.js";
import type { PasswordResetMailer } from "./passwordResetMail.js";

/** Issue #142's "30-minute default expiry" for a reset token. */
export const PASSWORD_RESET_TOKEN_TTL_SECONDS = 30 * 60;

/** Window `PASSWORD_RESET_MAX_REQUESTS_PER_WINDOW` is counted over, for `requestPasswordReset`'s throttle. */
export const PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
/**
 * Cap on reset tokens one account can have issued within `PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS`.
 * Past this, `requestPasswordReset` silently skips issuing a token and sending mail — same
 * no-op shape as an unknown email — so a caller who knows a victim's address can't flood their
 * inbox or churn through the token table, mirroring `loginLockout.ts`'s throttle on the login path.
 */
export const PASSWORD_RESET_MAX_REQUESTS_PER_WINDOW = 3;

/** Path the emailed link points at; the web app owns rendering a form at this route. */
const PASSWORD_RESET_PATH = "/reset-password";

function buildPasswordResetUrl(appBaseUrl: string, token: string): string {
  const url = new URL(PASSWORD_RESET_PATH, appBaseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

export interface RequestPasswordResetInput {
  email: string;
  /** Origin the emailed reset link is built against, e.g. `https://app.semprec.example`. */
  appBaseUrl: string;
}

/**
 * Issue #142's request half. Always resolves the same way — void, no thrown error, no
 * distinguishable timing-free signal — for a known and an unknown email alike, per the issue's
 * "request responses do not disclose whether an email exists". A token (high-entropy, only its
 * hash ever persisted — see `token.ts`'s `generateOpaqueToken`) is generated and stored only
 * when `email` resolves to a real user; for an unknown email this is a no-op past the lookup.
 * The same no-op path is taken when that user has already hit
 * `PASSWORD_RESET_MAX_REQUESTS_PER_WINDOW` reset tokens within the rate-limit window, so a
 * caller flooding a known victim's inbox gets an identical response to one probing an unknown
 * address — no separate "too many requests" signal to key off of.
 *
 * The DB write (token row) commits in its own transaction before the SMTP call runs, mirroring
 * `sendDraftEmail`'s (mail/send.ts) "claim before I/O" shape but for the opposite reason here:
 * there's nothing to compensate if the email fails to send, since the token is already usable
 * from the DB's perspective and a caller can always request a fresh one. A mailer failure is
 * logged, not thrown — this endpoint's response must stay identical to the unknown-email case.
 */
export async function requestPasswordReset(
  pool: Pool,
  mailer: PasswordResetMailer,
  input: RequestPasswordResetInput,
): Promise<void> {
  const email = normalizeEmail(input.email);

  const created = await withTransaction(pool, async (client) => {
    const user = await getUserByEmail(client, email);
    if (!user) return null;

    const recentCount = await countRecentPasswordResetTokens(client, user.id, PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS);
    if (recentCount >= PASSWORD_RESET_MAX_REQUESTS_PER_WINDOW) return null;

    const { token, tokenHash } = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_SECONDS * 1000);
    await createPasswordResetToken(client, { userId: user.id, tokenHash, expiresAt });
    return { token, email: user.email };
  });

  if (!created) return;

  try {
    await mailer.sendPasswordResetEmail({
      to: created.email,
      resetUrl: buildPasswordResetUrl(input.appBaseUrl, created.token),
    });
  } catch (err) {
    console.error("requestPasswordReset: failed to send the password-reset email", err);
  }
}

export interface ResetPasswordInput {
  token: string;
  newPassword: string;
}

/**
 * Issue #142's consume half. `consumePasswordResetToken` is the one statement that atomically
 * requires the token to be unexpired and unused *and* marks it consumed, so this can't be raced
 * into accepting the same token twice. When that update matches no row, a read-only follow-up
 * lookup classifies *why* — no such token, already consumed, or expired — into the matching
 * `PasswordResetTokenError` reason, per the issue's "deterministic invalid/expired/consumed
 * responses" (unlike `login`, which deliberately collapses every failure into one message).
 *
 * Also revokes every other active session for the user, in the same transaction as the password
 * write. Password reset is the recovery path for a compromised account, so a session an attacker
 * held before the reset must not outlive it — without this, that session would keep working for
 * its full `SESSION_TTL_SECONDS` regardless of the password change.
 *
 * Takes a `PoolClient`, not `Pool | PoolClient`, on purpose: consuming the token, writing the new
 * password hash, and revoking sessions is only atomic — "consumed but the password never
 * changed" can't happen — inside one caller-managed transaction. A bare `Pool` would auto-commit
 * each statement independently, so the signature forces every caller (the HTTP handler already
 * wraps this in `withTransaction`) to supply one.
 */
export async function resetPassword(client: PoolClient, input: ResetPasswordInput): Promise<void> {
  const tokenHash = hashToken(input.token);

  const consumed = await consumePasswordResetToken(client, tokenHash);
  if (!consumed) {
    const existing = await getPasswordResetTokenByHash(client, tokenHash);
    if (!existing) throw new PasswordResetTokenError("invalid");
    if (existing.consumedAt) throw new PasswordResetTokenError("consumed");
    throw new PasswordResetTokenError("expired");
  }

  const passwordHash = await hashPassword(input.newPassword);
  await updateUserPasswordHash(client, consumed.userId, passwordHash);
  await revokeAllSessionsForUser(client, consumed.userId);
}
