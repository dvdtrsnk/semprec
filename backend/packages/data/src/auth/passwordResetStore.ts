import type { Pool, PoolClient } from "pg";
import { requireSingleRow } from "../db/pool.js";
import type { PasswordResetTokenRow } from "./types.js";

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

/** Counts regardless of expired/consumed state: the throttle is on emails triggered. */
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
 * The single statement that makes a reset single-use: check and mark in one `UPDATE`, so of two
 * concurrent attempts the loser matches zero rows. `null` for unknown, consumed or expired.
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
 * Includes expired tokens. Waits on locked token rows, so a caller already holding the user row
 * `FOR UPDATE` must use `consumeUnlockedPasswordResetTokensForUser` instead (deadlock with
 * `resetPassword`, which holds its token row while waiting for the user row).
 */
export async function consumeAllPasswordResetTokensForUser(client: Pool | PoolClient, userId: string): Promise<number> {
  const result = await client.query(
    `UPDATE password_reset_tokens SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId],
  );
  return result.rowCount ?? 0;
}

/**
 * For a caller holding the user row `FOR UPDATE`: marks with `SKIP LOCKED`, never waiting, then
 * counts what is left (tokens locked by an uncommitted transaction). `remaining` is exact only
 * under that lock: a token insert takes the user row `FOR KEY SHARE` through its FK, so none can
 * commit meanwhile. See docs/architecture/tenancy-and-security.md#password-reset-and-change.
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
