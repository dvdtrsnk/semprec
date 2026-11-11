import type { Pool, PoolClient } from "pg";
import { requireSingleRow } from "../db/pool.js";
import type { PasswordResetTokenRow } from "./types.js";

/** The raw `password_reset_tokens` row shape this module reads back from Postgres. */
type PasswordResetTokenDbRow = {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
};

function mapRow(row: PasswordResetTokenDbRow): PasswordResetTokenRow {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    consumedAt: row.consumed_at ? row.consumed_at.toISOString() : null,
  };
}

const SELECT_COLUMNS = "id, user_id, token_hash, created_at, expires_at, consumed_at";

export interface CreatePasswordResetTokenInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

/** Throws (unique violation) in the astronomically unlikely event `tokenHash` collides with an existing row. */
export async function createPasswordResetToken(
  client: Pool | PoolClient,
  input: CreatePasswordResetTokenInput,
): Promise<PasswordResetTokenRow> {
  const { rows } = await client.query<PasswordResetTokenDbRow>(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING ${SELECT_COLUMNS}`,
    [input.userId, input.tokenHash, input.expiresAt],
  );
  return mapRow(requireSingleRow(rows, "password_reset_tokens row"));
}

/**
 * Count of reset tokens issued to `userId` within the last `windowSeconds`, regardless of their
 * current expired/consumed state — the throttling signal `requestPasswordReset` (issue #142)
 * uses to cap how many reset emails one account can trigger per window, same shape as
 * `countRecentFailedAttempts` in loginAttemptsStore.ts.
 */
export async function countRecentPasswordResetTokens(
  client: Pool | PoolClient,
  userId: string,
  windowSeconds: number,
): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*) FROM password_reset_tokens
     WHERE user_id = $1 AND created_at > now() - make_interval(secs => $2)`,
    [userId, windowSeconds],
  );
  return Number(requireSingleRow(rows, "password_reset_tokens recent count").count);
}

export async function getPasswordResetTokenByHash(
  client: Pool | PoolClient,
  tokenHash: string,
): Promise<PasswordResetTokenRow | null> {
  const { rows } = await client.query<PasswordResetTokenDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM password_reset_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * The single statement that makes a reset single-use: a token is only ever marked consumed by
 * this `UPDATE ... RETURNING`, gated on the same row simultaneously being unexpired and
 * unconsumed, so two concurrent consume attempts for the same token can't both succeed — the
 * loser's `UPDATE` matches zero rows instead of racing a separate read-then-write. Returns
 * `null` for a token that doesn't exist, is already consumed, or has expired; the caller (see
 * `resetPassword`, auth/passwordResetActions.ts) does a follow-up read-only lookup only to
 * classify *which* of those applied, for a deterministic error response.
 */
export async function consumePasswordResetToken(
  client: Pool | PoolClient,
  tokenHash: string,
): Promise<PasswordResetTokenRow | null> {
  const { rows } = await client.query<PasswordResetTokenDbRow>(
    `UPDATE password_reset_tokens
     SET consumed_at = now()
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING ${SELECT_COLUMNS}`,
    [tokenHash],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Marks every unconsumed reset token of `userId` consumed, the expired ones included, so a link issued
 * earlier answers `password_reset_token_consumed` (issue #1701). Zero is a legitimate result: the user
 * may have no unconsumed token. Returns the number of tokens it marked.
 *
 * It waits for a token row that another transaction has locked. `resetPassword` holds the row of the
 * token it is consuming while it waits for the user row, so a caller that holds that user row
 * `FOR UPDATE` must not call this: it uses `consumeUnlockedPasswordResetTokensForUser`.
 */
export async function consumeAllPasswordResetTokensForUser(client: Pool | PoolClient, userId: string): Promise<number> {
  const result = await client.query(
    `UPDATE password_reset_tokens SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId],
  );
  return result.rowCount ?? 0;
}

/**
 * `consumeAllPasswordResetTokensForUser` for a caller that holds the row of `userId` in `users`
 * `FOR UPDATE` (issue #1701). It never waits for a token row: it marks the user's unconsumed tokens
 * that no other transaction has locked (`FOR UPDATE SKIP LOCKED`), the expired ones included, and then
 * counts the unconsumed tokens that are left. Returns both numbers; zero is a legitimate value of each.
 *
 * A token is left only when another transaction had its row locked while the marking ran: a
 * `resetPassword` that is consuming it, or another transaction that is marking it. That transaction has
 * not committed, and the token is usable again if it rolls back.
 *
 * `remaining` is exact only under that user-row lock. An insert into `password_reset_tokens` takes the
 * user row `FOR KEY SHARE` through its foreign key, so while the caller holds the row `FOR UPDATE` no
 * transaction can commit a new token of the user: `remaining === 0` then means that the user has no
 * unconsumed token until the caller's transaction ends. Takes a `PoolClient` because the two statements
 * must share the transaction that holds the lock. See
 * docs/adr/2026-11-10-password-change-marks-reset-tokens-before-and-under-the-user-row-lock.md.
 */
export async function consumeUnlockedPasswordResetTokensForUser(
  client: PoolClient,
  userId: string,
): Promise<{ consumed: number; remaining: number }> {
  const marked = await client.query(
    `UPDATE password_reset_tokens SET consumed_at = now()
      WHERE id IN (
        SELECT id FROM password_reset_tokens
         WHERE user_id = $1 AND consumed_at IS NULL
           FOR UPDATE SKIP LOCKED
      )`,
    [userId],
  );
  const { rows } = await client.query<{ remaining: number }>(
    `SELECT count(*)::int AS remaining FROM password_reset_tokens WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId],
  );
  return {
    consumed: marked.rowCount ?? 0,
    remaining: requireSingleRow(rows, "password_reset_tokens unconsumed count").remaining,
  };
}
