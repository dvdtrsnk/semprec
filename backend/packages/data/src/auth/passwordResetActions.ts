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

export const PASSWORD_RESET_TOKEN_TTL_SECONDS = 30 * 60;

export const PASSWORD_RESET_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
/** Past this, requests are a silent no-op (like an unknown email), so a victim's inbox cannot be flooded. */
export const PASSWORD_RESET_MAX_REQUESTS_PER_WINDOW = 3;

/** Response-time floor so unknown, capped and issued paths cannot be told apart. */
export const PASSWORD_RESET_REQUEST_MIN_DURATION_MS = 400;

/** The token rides in the fragment, never the query string, to stay out of access logs and `Referer`. */
function buildPasswordResetUrl(appBaseUrl: string, token: string): string {
  const url = new URL("/", appBaseUrl);
  url.searchParams.set("page", "password-reset");
  url.hash = `token=${token}`;
  return url.toString();
}

export interface RequestPasswordResetInput {
  email: string;
  appBaseUrl: string;
}

/**
 * Resolves identically for known, unknown, inactive and rate-capped emails, and no earlier than
 * `PASSWORD_RESET_REQUEST_MIN_DURATION_MS`, so neither the response nor its timing reveals whether
 * an account exists. A path that throws is not delayed.
 *
 * The mail is sent after commit and not awaited, so SMTP latency leaks nothing. A send failure is
 * only logged; the user requests again and the committed token needs no compensation.
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
        .sendPasswordResetEmail({
          to: user.email,
          resetUrl: buildPasswordResetUrl(input.appBaseUrl, token),
          locale: user.locale,
        })
        .catch((err: unknown) => {
          // An SMTP refusal can echo the recipient address, so the error object is never logged.
          logger.error(
            { userId: user.id, err: describeMailFailure(err) },
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
 * The token is checked and consumed in one statement so it cannot be used twice; on a miss a
 * read-only lookup classifies the reason (unlike `login`, reset errors are deliberately specific).
 *
 * Revokes all sessions and push registrations: reset is the recovery path for a compromised
 * account, so an attacker's session must not outlive it. Takes a `PoolClient` so token, hash and
 * revocations commit atomically in the caller's transaction. Password length is validated before
 * the token is consumed, so the user can retry with the same link.
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
