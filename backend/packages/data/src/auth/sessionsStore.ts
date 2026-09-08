import type { Pool, PoolClient } from "pg";
import { assertKnownValue } from "../dbRowValidation.js";
import { SESSION_PLATFORMS, type SessionRow } from "./types.js";

function mapRow(row: {
  id: string;
  user_id: string;
  token_hash: string;
  platform: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  user_agent: string | null;
  revoked_at: Date | null;
}): SessionRow {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    platform: assertKnownValue(SESSION_PLATFORMS, row.platform, "platform"),
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    userAgent: row.user_agent,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

const SELECT_COLUMNS = "id, user_id, token_hash, platform, created_at, last_seen_at, expires_at, user_agent, revoked_at";

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  platform: (typeof SESSION_PLATFORMS)[number];
  expiresAt: Date;
  userAgent?: string | null;
}

/** Throws (unique violation) in the astronomically unlikely event `tokenHash` collides with a live session. */
export async function createSession(client: Pool | PoolClient, input: CreateSessionInput): Promise<SessionRow> {
  const { rows } = await client.query(
    `INSERT INTO sessions (user_id, token_hash, platform, expires_at, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SELECT_COLUMNS}`,
    [input.userId, input.tokenHash, input.platform, input.expiresAt, input.userAgent ?? null],
  );
  return mapRow(rows[0]);
}

/** A session is "active" when it is neither revoked nor past its expiry — the two independent ways a token stops working. */
export async function getActiveSessionByTokenHash(client: Pool | PoolClient, tokenHash: string): Promise<SessionRow | null> {
  const { rows } = await client.query(
    `SELECT ${SELECT_COLUMNS} FROM sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [tokenHash],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function touchSessionLastSeen(client: Pool | PoolClient, id: string): Promise<void> {
  await client.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [id]);
}

export async function revokeSession(client: Pool | PoolClient, id: string): Promise<void> {
  await client.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]);
}

export async function listSessionsForUser(client: Pool | PoolClient, userId: string): Promise<SessionRow[]> {
  const { rows } = await client.query(
    `SELECT ${SELECT_COLUMNS} FROM sessions WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(mapRow);
}
