import type { Pool, PoolClient } from "pg";
import type { UserRow } from "./types.js";

function mapRow(row: { id: string; email: string; password_hash: string; locale: string; created_at: Date }): UserRow {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    locale: row.locale,
    createdAt: row.created_at.toISOString(),
  };
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  /** Defaults to the `users.locale` column default (`cs`) when omitted. */
  locale?: string;
}

/** Throws (unique violation, Postgres error code `23505`) if `email` is already taken. */
export async function createUser(client: Pool | PoolClient, input: CreateUserInput): Promise<UserRow> {
  const { rows } =
    input.locale === undefined
      ? await client.query(
          `INSERT INTO users (email, password_hash) VALUES ($1, $2)
           RETURNING id, email, password_hash, locale, created_at`,
          [input.email, input.passwordHash],
        )
      : await client.query(
          `INSERT INTO users (email, password_hash, locale) VALUES ($1, $2, $3)
           RETURNING id, email, password_hash, locale, created_at`,
          [input.email, input.passwordHash, input.locale],
        );
  return mapRow(rows[0]);
}

export async function getUserByEmail(client: Pool | PoolClient, email: string): Promise<UserRow | null> {
  const { rows } = await client.query(
    `SELECT id, email, password_hash, locale, created_at FROM users WHERE email = $1`,
    [email],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getUserById(client: Pool | PoolClient, id: string): Promise<UserRow | null> {
  const { rows } = await client.query(`SELECT id, email, password_hash, locale, created_at FROM users WHERE id = $1`, [
    id,
  ]);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Backs the setup API's (#233) "no account exists yet" gate — cheaper than a `count(*)` since it can stop at the first row. */
export async function anyUserExists(client: Pool | PoolClient): Promise<boolean> {
  const { rows } = await client.query(`SELECT EXISTS(SELECT 1 FROM users) AS "exists"`);
  return (rows[0] as { exists: boolean }).exists;
}

/**
 * Semprec is a personal, single-tenant system — `databases`/`items` carry no owning-user column
 * at all (only `owner_project_item_id`), so a background action with no per-request session
 * (e.g. the drift-check heartbeat, `manifest/driftCheck.ts`) has no other honest way to find
 * "the" user whose `users.locale` a runtime-generated manifest should resolve against. The
 * first-created account is the closest stand-in for that single owner. Returns `null` before
 * setup (#233) has created any account yet.
 */
export async function getEarliestUserLocale(client: Pool | PoolClient): Promise<string | null> {
  const { rows } = await client.query(`SELECT locale FROM users ORDER BY created_at ASC, id ASC LIMIT 1`);
  return rows[0] ? (rows[0] as { locale: string }).locale : null;
}

/** Used by `resetPassword` (auth/passwordResetActions.ts) to replace a user's password hash after a reset token is consumed. */
export async function updateUserPasswordHash(
  client: Pool | PoolClient,
  id: string,
  passwordHash: string,
): Promise<void> {
  await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, id]);
}
