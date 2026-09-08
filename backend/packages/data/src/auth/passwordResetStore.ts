import type { Pool, PoolClient } from "pg";
import { requireSingleRow } from "../db/pool.js";
import type { PasswordResetTokenRow } from "./types.js";

function mapRow(row: {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}): PasswordResetTokenRow {
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
  const { rows } = await client.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)
     RETURNING ${SELECT_COLUMNS}`,
    [input.userId, input.tokenHash, input.expiresAt],
  );
  return mapRow(rows[0]);
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
  const { rows } = await client.query(`SELECT ${SELECT_COLUMNS} FROM password_reset_tokens WHERE token_hash = $1`, [
    tokenHash,
  ]);
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
  const { rows } = await client.query(
    `UPDATE password_reset_tokens
     SET consumed_at = now()
     WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
     RETURNING ${SELECT_COLUMNS}`,
    [tokenHash],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}
