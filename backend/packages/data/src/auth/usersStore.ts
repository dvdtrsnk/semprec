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
