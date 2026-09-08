import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import { PasswordResetTokenError } from "../errors.js";
import { hashPassword } from "./passwordHash.js";
import { generateOpaqueToken, hashToken } from "./token.js";
import { getUserByEmail, updateUserPasswordHash } from "./usersStore.js";
import {
  consumePasswordResetToken,
  createPasswordResetToken,
  getPasswordResetTokenByHash,
} from "./passwordResetStore.js";
import { normalizeEmail } from "./emailNormalization.js";
import type { PasswordResetMailer } from "./passwordResetMail.js";

/** Issue #142's "30-minute default expiry" for a reset token. */
export const PASSWORD_RESET_TOKEN_TTL_SECONDS = 30 * 60;

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
 */
export async function resetPassword(client: Pool | PoolClient, input: ResetPasswordInput): Promise<void> {
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
}
