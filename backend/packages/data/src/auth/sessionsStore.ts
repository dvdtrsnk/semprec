import type { Pool, PoolClient } from "pg";
import { requireAffectedRows, requireSingleRow, runAfterCommit } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { notifySessionRevoked } from "../realtimeHook.js";
import { SESSION_DEVICE_KINDS, SESSION_PLATFORMS, type SessionDeviceKind, type SessionRow } from "./types.js";

/**
 * Deferred to commit on a `PoolClient`; on a bare `Pool` the statement already auto-committed, so
 * it fires immediately.
 */
function fireSessionRevoked(client: Pool | PoolClient, sessionId: string): void {
  if ("release" in client) {
    runAfterCommit(client, () => notifySessionRevoked({ sessionId }));
  } else {
    notifySessionRevoked({ sessionId });
  }
}

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
  device_id: string | null;
  device_name: string | null;
  device_kind: string | null;
  os_version: string | null;
  app_version: string | null;
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
    deviceId: row.device_id,
    deviceName: row.device_name,
    deviceKind:
      row.device_kind === null ? null : assertKnownValue(SESSION_DEVICE_KINDS, row.device_kind, "device_kind"),
    osVersion: row.os_version,
    appVersion: row.app_version,
  };
}

const SELECT_COLUMNS =
  "id, user_id, token_hash, platform, created_at, last_seen_at, expires_at, user_agent, revoked_at, device_id, device_name, device_kind, os_version, app_version";

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  platform: (typeof SESSION_PLATFORMS)[number];
  expiresAt: Date;
  userAgent?: string | null;
  deviceId?: string | null;
  deviceName?: string | null;
  deviceKind?: SessionDeviceKind | null;
  osVersion?: string | null;
  appVersion?: string | null;
}

export async function createSession(client: Pool | PoolClient, input: CreateSessionInput): Promise<SessionRow> {
  const { rows } = await client.query<SessionDbRow>(
    `INSERT INTO sessions (user_id, token_hash, platform, expires_at, user_agent, device_id, device_name, device_kind, os_version, app_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.userId,
      input.tokenHash,
      input.platform,
      input.expiresAt,
      input.userAgent ?? null,
      input.deviceId ?? null,
      input.deviceName ?? null,
      input.deviceKind ?? null,
      input.osVersion ?? null,
      input.appVersion ?? null,
    ],
  );
  return mapRow(requireSingleRow(rows, "sessions row"));
}

/** Active means neither revoked nor expired. */
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

/** Slides `expires_at` to `now() + idle`, never backwards and never past `created_at + max lifetime`. */
export async function touchSessionLastSeen(
  client: Pool | PoolClient,
  input: { id: string; idleSeconds: number; maxLifetimeSeconds: number },
): Promise<void> {
  const result = await client.query(
    `UPDATE sessions
     SET last_seen_at = now(),
         expires_at = LEAST(
           created_at + make_interval(secs => $3::double precision),
           GREATEST(expires_at, now() + make_interval(secs => $2::double precision))
         )
     WHERE id = $1`,
    [input.id, input.idleSeconds, input.maxLifetimeSeconds],
  );
  requireAffectedRows(result, "sessions row touched");
}

export async function revokeSession(client: Pool | PoolClient, id: string): Promise<void> {
  const result = await client.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [
    id,
  ]);
  if ((result.rowCount ?? 0) > 0) fireSessionRevoked(client, id);
}

/** Scoped to the owner so a guessed foreign id cannot be revoked. */
export async function revokeSessionForUser(client: Pool | PoolClient, id: string, userId: string): Promise<boolean> {
  const result = await client.query(
    `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [id, userId],
  );
  const revoked = (result.rowCount ?? 0) > 0;
  if (revoked) fireSessionRevoked(client, id);
  return revoked;
}

export async function revokeAllSessionsForUser(client: Pool | PoolClient, userId: string): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`,
    [userId],
  );
  for (const row of rows) fireSessionRevoked(client, row.id);
}

/** Returns the revoked ids. */
export async function revokeOtherSessionsForUser(
  client: Pool | PoolClient,
  userId: string,
  keepSessionId: string,
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL RETURNING id`,
    [userId, keepSessionId],
  );
  if ((result.rowCount ?? 0) === 0) return [];
  for (const row of result.rows) fireSessionRevoked(client, row.id);
  return result.rows.map((row) => row.id);
}

/**
 * Returns the revoked ids. Does not by itself exclude a concurrent login of the same installation;
 * `login` takes `lockSessionDevice` first.
 */
export async function revokeSessionsForDevice(
  client: PoolClient,
  userId: string,
  deviceId: string,
  exceptSessionId: string,
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `UPDATE sessions SET revoked_at = now()
     WHERE user_id = $1 AND device_id = $2 AND id <> $3 AND revoked_at IS NULL
     RETURNING id`,
    [userId, deviceId, exceptSessionId],
  );
  if ((result.rowCount ?? 0) === 0) return [];
  for (const row of result.rows) fireSessionRevoked(client, row.id);
  return result.rows.map((row) => row.id);
}

/** Heartbeat fallback for sockets whose LISTEN connection missed the revocation NOTIFY. */
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

export async function listActiveSessionsForUser(client: Pool | PoolClient, userId: string): Promise<SessionRow[]> {
  const { rows } = await client.query<SessionDbRow>(
    `SELECT ${SELECT_COLUMNS} FROM sessions
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY last_seen_at DESC, id`,
    [userId],
  );
  return rows.map(mapRow);
}
