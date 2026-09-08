import type { Pool, PoolClient } from "pg";
import { requireSingleRow } from "../db/pool.js";
import type { LoginAttemptRow } from "./types.js";

function mapRow(row: {
  id: string;
  email: string;
  ip: string;
  succeeded: boolean;
  attempted_at: Date;
}): LoginAttemptRow {
  return {
    id: row.id,
    email: row.email,
    ip: row.ip,
    succeeded: row.succeeded,
    attemptedAt: row.attempted_at.toISOString(),
  };
}

export interface RecordLoginAttemptInput {
  email: string;
  ip: string;
  succeeded: boolean;
}

/** No FK to `users`: an attempt against an email that doesn't exist is still recorded, for throttling and audit alike. */
export async function recordLoginAttempt(
  client: Pool | PoolClient,
  input: RecordLoginAttemptInput,
): Promise<LoginAttemptRow> {
  const { rows } = await client.query(
    `INSERT INTO login_attempts (email, ip, succeeded) VALUES ($1, $2, $3)
     RETURNING id, email, ip, succeeded, attempted_at`,
    [input.email, input.ip, input.succeeded],
  );
  return mapRow(rows[0]);
}

/** Count of failed attempts for `email` from `ip` within the last `windowSeconds` — the throttling signal for #140's login endpoint. */
export async function countRecentFailedAttempts(
  client: Pool | PoolClient,
  email: string,
  ip: string,
  windowSeconds: number,
): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*) FROM login_attempts
     WHERE email = $1 AND ip = $2 AND succeeded = false AND attempted_at > now() - make_interval(secs => $3)`,
    [email, ip, windowSeconds],
  );
  return Number(requireSingleRow(rows, "login_attempts failure count").count);
}

export interface FailureStreak {
  /** Consecutive failed attempts for this email+IP pair since their last success (or ever, if there is none). */
  count: number;
  /** When the most recent of those failures happened; `null` when `count` is 0. */
  lastFailedAt: string | null;
}

/**
 * The signal #232's exponential lockout is built on: unlike `countRecentFailedAttempts`'s fixed
 * time window, this counts back only to the pair's last *success*, so a lockout naturally lifts
 * as soon as a login succeeds instead of lingering until an unrelated window expires.
 */
export async function getFailureStreak(client: Pool | PoolClient, email: string, ip: string): Promise<FailureStreak> {
  const { rows } = await client.query<{ count: string; last_failed_at: Date | null }>(
    `SELECT count(*) AS count, max(attempted_at) AS last_failed_at
     FROM login_attempts
     WHERE email = $1 AND ip = $2 AND succeeded = false
       AND attempted_at > COALESCE(
         (SELECT max(attempted_at) FROM login_attempts WHERE email = $1 AND ip = $2 AND succeeded = true),
         '-infinity'
       )`,
    [email, ip],
  );
  const row = requireSingleRow(rows, "login_attempts failure streak");
  return {
    count: Number(row.count),
    lastFailedAt: row.last_failed_at ? row.last_failed_at.toISOString() : null,
  };
}
