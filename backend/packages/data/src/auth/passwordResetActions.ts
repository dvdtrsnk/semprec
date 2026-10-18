import type { Pool, PoolClient } from "pg";
import { runAfterCommit, withTransaction } from "../db/pool.js";
import { PasswordResetTokenError, ValidationError } from "../errors.js";
import { MIN_PASSWORD_LENGTH } from "./authActions.js";
import { hashPassword } from "./passwordHash.js";
import { generateOpaqueToken, hashToken } from "./token.js";
import { getUserByEmail, updateUserPasswordHash } from "./usersStore.js";
import { lockUserTenantBinding } from "../tenancy/tenantsStore.js";
import { revokeAllSessionsForUser } from "./sessionsStore.js";
import { revokeAllPushSubscriptionsForUser } from "../push/pushSubscriptionsStore.js";
import {
  consumePasswordResetToken,
  countRecentPasswordResetTokens,
  createPasswordResetToken,
  getPasswordResetTokenByHash,
} from "./passwordResetStore.js";
import { normalizeEmail } from "./emailNormalization.js";
import type { PasswordResetMailer } from "./passwordResetMail.js";
import { describeMailFailure } from "../mail/describeMailFailure.js";
import { logger } from "./logger.js";

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

/**
 * Floor on how long `requestPasswordReset` takes to resolve, so an unknown email, a capped account
 * and a freshly issued token cannot be told apart by response time.
 */
export const PASSWORD_RESET_REQUEST_MIN_DURATION_MS = 400;

/**
 * The emailed link opens the web app's `password-reset` page. The token rides in the URL fragment
 * (`#token=`), never the query string, so it stays out of access logs and `Referer` headers; the
 * page reads it from `location.hash` and clears it from the address bar on mount.
 */
function buildPasswordResetUrl(appBaseUrl: string, token: string): string {
  const url = new URL("/", appBaseUrl);
  url.searchParams.set("page", "password-reset");
  url.hash = `token=${token}`;
  return url.toString();
}

export interface RequestPasswordResetInput {
  email: string;
  /** Origin the emailed reset link is built against, e.g. `https://app.semprec.example`. */
  appBaseUrl: string;
}

/**
 * Issue #142's request half. Always resolves the same way — void, no thrown error — for a known
 * and an unknown email alike, per the issue's "request responses do not disclose whether an email
 * exists". A token (high-entropy, only its hash ever persisted — see `token.ts`'s
 * `generateOpaqueToken`) is generated and stored only when `email` resolves to a real user; for an
 * unknown email this is a no-op past the lookup. The same no-op path is taken when that user has
 * already hit `PASSWORD_RESET_MAX_REQUESTS_PER_WINDOW` reset tokens within the rate-limit window,
 * so a caller flooding a known victim's inbox gets an identical response to one probing an unknown
 * address — no separate "too many requests" signal to key off of.
 *
 * The token row commits first; the reset mail is dispatched from a `runAfterCommit` callback, so a
 * rolled-back transaction sends nothing, and the send is started after `COMMIT` without being
 * awaited. The function resolves after the commit and the minimum duration below, independently
 * of the mail send, so its response time carries no signal from the SMTP server.
 * Per `docs/adr/2026-09-10-side-effects-follow-the-commit.md`,
 * a callback's failure is invisible to its caller: a send failure is logged and never surfaces, and
 * a user who never receives the mail requests again — the committed token needs no compensation.
 *
 * Every path that returns (unknown email, inactive tenant, per-account cap, token issued) resolves
 * no earlier than `PASSWORD_RESET_REQUEST_MIN_DURATION_MS` after the call, because the paths differ
 * in database work and that difference would otherwise reveal whether an account exists. A path
 * that throws is not delayed.
 */
export async function requestPasswordReset(
  pool: Pool,
  mailer: PasswordResetMailer,
  input: RequestPasswordResetInput,
): Promise<void> {
  const startedAt = Date.now();
  const email = normalizeEmail(input.email);

  await withTransaction(pool, async (client) => {
    const user = await getUserByEmail(client, email);
    if (!user) return;
    // A user whose tenant is missing or not active takes the unknown-email path: no token, no mail.
    const binding = await lockUserTenantBinding(client, user.id);
    if (!binding || binding.status !== "active") return;

    const recentCount = await countRecentPasswordResetTokens(client, user.id, PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS);
    if (recentCount >= PASSWORD_RESET_MAX_REQUESTS_PER_WINDOW) return;

    const { token, tokenHash } = generateOpaqueToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_SECONDS * 1000);
    await createPasswordResetToken(client, { userId: user.id, tokenHash, expiresAt });
    runAfterCommit(client, () => {
      void mailer
        .sendPasswordResetEmail({ to: user.email, resetUrl: buildPasswordResetUrl(input.appBaseUrl, token) })
        .catch((err: unknown) => {
          // An SMTP refusal can echo the recipient address, so the error object is never logged.
          logger.error(
            { userId: user.id, ...describeMailFailure(err) },
            "requestPasswordReset: failed to send the password-reset email",
          );
        });
    });
  });

  const remainingMs = PASSWORD_RESET_REQUEST_MIN_DURATION_MS - (Date.now() - startedAt);
  if (remainingMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, remainingMs));
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
 * its full `SESSION_TTL_SECONDS` regardless of the password change. Push registrations are revoked
 * with the sessions (issue #1024), including the ones that have no session.
 *
 * Takes a `PoolClient`, not `Pool | PoolClient`, on purpose: consuming the token, writing the new
 * password hash, and revoking sessions is only atomic — "consumed but the password never
 * changed" can't happen — inside one caller-managed transaction. A bare `Pool` would auto-commit
 * each statement independently, so the signature forces every caller (the HTTP handler already
 * wraps this in `withTransaction`) to supply one.
 *
 * Rejects a `newPassword` shorter than `MIN_PASSWORD_LENGTH` with a `ValidationError` before
 * `consumePasswordResetToken` runs, so a rejected password never consumes the single-use token
 * and the user can retry with the same link.
 */
export async function resetPassword(client: PoolClient, input: ResetPasswordInput): Promise<void> {
  if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new ValidationError(`'newPassword' must be at least ${MIN_PASSWORD_LENGTH} characters`, {
      field: "newPassword",
    });
  }

  const tokenHash = hashToken(input.token);

  const consumed = await consumePasswordResetToken(client, tokenHash);
  if (!consumed) {
    const existing = await getPasswordResetTokenByHash(client, tokenHash);
    if (!existing) throw new PasswordResetTokenError("invalid");
    if (existing.consumedAt) throw new PasswordResetTokenError("consumed");
    throw new PasswordResetTokenError("expired");
  }

  // A token issued before a suspension is refused; the caller's rollback leaves it unconsumed.
  const binding = await lockUserTenantBinding(client, consumed.userId);
  if (!binding || binding.status !== "active") throw new PasswordResetTokenError("invalid");

  const passwordHash = await hashPassword(input.newPassword);
  await updateUserPasswordHash(client, consumed.userId, passwordHash);
  await revokeAllSessionsForUser(client, consumed.userId);
  await revokeAllPushSubscriptionsForUser(client, consumed.userId);
}
