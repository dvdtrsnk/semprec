import type { Pool, PoolClient } from "pg";
import { requireSingleRow, runAfterCommit } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { notifySessionRevoked } from "../realtimeHook.js";
import { SESSION_PLATFORMS, type SessionRow } from "./types.js";

/**
 * Fires the realtime session-revocation event (issue #160's `WS /api/sync` closes that
 * session's sockets with 4401 on it) for an id that was just actually revoked. Deferred via
 * `runAfterCommit` when `client` is a transaction-scoped `PoolClient` — this store's revoke
 * functions accept a bare `Pool` too (single auto-committed statement, so there's no later
 * commit/rollback to wait for and the event fires immediately).
 */
function fireSessionRevoked(client: Pool | PoolClient, sessionId: string): void {
  if ("release" in client) {
    runAfterCommit(client, () => notifySessionRevoked({ sessionId }));
  } else {
    notifySessionRevoked({ sessionId });
  }
}

/** The raw `sessions` row shape this module reads back from Postgres. */
type SessionDbRow = {
  id: string;
  user_id: string;
  token_hash: string;
  platform: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  user_agent: string | null;
  revoked_at: Date | null;
};

function mapRow(row: SessionDbRow): SessionRow {
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

const SELECT_COLUMNS =
  "id, user_id, token_hash, platform, created_at, last_seen_at, expires_at, user_agent, revoked_at";

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  platform: (typeof SESSION_PLATFORMS)[number];
  expiresAt: Date;
  userAgent?: string | null;
}

/** Throws (unique violation) in the astronomically unlikely event `tokenHash` collides with a live session. */
export async function createSession(client: Pool | PoolClient, input: CreateSessionInput): Promise<SessionRow> {
  const { rows } = await client.query<SessionDbRow>(
    `INSERT INTO sessions (user_id, token_hash, platform, expires_at, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SELECT_COLUMNS}`,
    [input.userId, input.tokenHash, input.platform, input.expiresAt, input.userAgent ?? null],
  );
  return mapRow(requireSingleRow(rows, "sessions row"));
}

/** A session is "active" when it is neither revoked nor past its expiry — the two independent ways a token stops working. */
export async function getActiveSessionByTokenHash(
  client: Pool | PoolClient,
  tokenHash: string,
): Promise<SessionRow | null> {
  const { rows } = await client.query<SessionDbRow>(
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
  const result = await client.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [
    id,
  ]);
  if ((result.rowCount ?? 0) > 0) fireSessionRevoked(client, id);
}

/**
 * Same revocation as `revokeSession`, scoped to a specific owning user — the guard remote
 * "revoke that other session" needs so a caller can't revoke a session id they don't own by
 * guessing it. Returns whether a row was actually revoked, so the caller can tell an unknown or
 * not-owned id apart from an already-revoked one without a separate lookup.
 */
export async function revokeSessionForUser(client: Pool | PoolClient, id: string, userId: string): Promise<boolean> {
  const result = await client.query(
    `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [id, userId],
  );
  const revoked = (result.rowCount ?? 0) > 0;
  if (revoked) fireSessionRevoked(client, id);
  return revoked;
}

/**
 * Revokes every still-active session for `userId` in one statement — the "kick everyone out"
 * counterpart to `revokeSessionForUser`'s single-session scope. `resetPassword` (issue #142)
 * calls this so a session an attacker held before the reset doesn't outlive it.
 */
export async function revokeAllSessionsForUser(client: Pool | PoolClient, userId: string): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
    [userId],
  );
  for (const row of rows) fireSessionRevoked(client, row.id);
}

/**
 * Whether `id` is still an active session — neither revoked nor expired. `WS /api/sync`'s
 * heartbeat (issue #160) calls this as a fallback to the NOTIFY-driven close, for the case where
 * a socket's connection to the LISTEN channel missed the revocation event (e.g. a reconnect
 * window).
 */
export async function isSessionActive(client: Pool | PoolClient, id: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM sessions WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [id],
  );
  return rows.length > 0;
}

export async function listSessionsForUser(client: Pool | PoolClient, userId: string): Promise<SessionRow[]> {
  const { rows } = await client.query<SessionDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM sessions WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(mapRow);
}
