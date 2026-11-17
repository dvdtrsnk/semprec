import type { Pool, PoolClient } from "pg";
import { requireSingleRow } from "../db/pool.js";
import type { SupportedLocale } from "./locales.js";
import type { UserRole, UserRow } from "./types.js";

// Re-exported here because `index.ts` is at the ESLint line cap.
export { publishAccountInvalidation } from "./accountInvalidation.js";

type UserDbRow = {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string;
  locale: string;
  created_at: Date;
};

function mapRow(row: UserDbRow): UserRow {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    locale: row.locale,
    createdAt: row.created_at.toISOString(),
  };
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  /** Column default (`cs`) when omitted. */
  locale?: string;
  /** Optional in the type, but `users.tenant_id` is NOT NULL: omitting it fails with `23502`. */
  tenantId?: string;
  /** Column default (`member`) when omitted. */
  role?: UserRole;
  /** Request-supplied names must go through `normalizeDisplayName` first. */
  displayName?: string;
}

/** Throws `23505` if `email` is already taken. */
export async function createUser(client: Pool | PoolClient, input: CreateUserInput): Promise<UserRow> {
  const columns = ["email", "password_hash"];
  const values: unknown[] = [input.email, input.passwordHash];
  const optional: [string, unknown][] = [
    ["locale", input.locale],
    ["tenant_id", input.tenantId],
    ["role", input.role],
    ["display_name", input.displayName],
  ];
  for (const [column, value] of optional) {
    if (value === undefined) continue;
    columns.push(column);
    values.push(value);
  }
  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await client.query<UserDbRow>(
    `INSERT INTO users (${columns.join(", ")}) VALUES (${placeholders})
     RETURNING id, email, display_name, password_hash, locale, created_at`,
    values,
  );
  return mapRow(requireSingleRow(rows, "users row"));
}

export async function getUserByEmail(client: Pool | PoolClient, email: string): Promise<UserRow | null> {
  const { rows } = await client.query<UserDbRow>(
    `SELECT id, email, display_name, password_hash, locale, created_at FROM users WHERE email = $1`,
    [email],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getUserById(client: Pool | PoolClient, id: string): Promise<UserRow | null> {
  const { rows } = await client.query<UserDbRow>(
    `SELECT id, email, display_name, password_hash, locale, created_at FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function anyUserExists(client: Pool | PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(`SELECT EXISTS(SELECT 1 FROM users) AS "exists"`);
  return rows[0]?.exists ?? false;
}

/** The recipient of a tenant event. `null` when the tenant has no user or outside a tenant scope. */
export async function getTenantUserId(client: Pool | PoolClient): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = (SELECT app_tenant_default())`,
  );
  return rows[0] ? rows[0].id : null;
}

/** Operator-alert recipients. Reads across tenants, so the caller must be in a system scope. */
export async function listAdminRecipients(
  client: Pool | PoolClient,
): Promise<Array<{ userId: string; tenantId: string }>> {
  const { rows } = await client.query<{ user_id: string; tenant_id: string }>(
    `SELECT u.id AS user_id, u.tenant_id
     FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE u.role = 'admin' AND t.status = 'active'
     ORDER BY u.created_at, u.id`,
  );
  return rows.map((row) => ({ userId: row.user_id, tenantId: row.tenant_id }));
}

/** Same recipient rule and `null` cases as `getTenantUserId`. */
export async function getTenantUserLocale(client: Pool | PoolClient): Promise<string | null> {
  const { rows } = await client.query<{ locale: string }>(
    `SELECT locale FROM users WHERE tenant_id = (SELECT app_tenant_default())`,
  );
  return rows[0] ? rows[0].locale : null;
}

export async function updateUserPasswordHash(
  client: Pool | PoolClient,
  id: string,
  passwordHash: string,
): Promise<void> {
  await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, id]);
}

/** `null` when nothing changed (same locale or no such user); a returned row means this call changed it. */
export async function updateUserLocale(
  client: Pool | PoolClient,
  userId: string,
  locale: SupportedLocale,
): Promise<UserRow | null> {
  const result = await client.query<UserDbRow>(
    `UPDATE users SET locale = $2 WHERE id = $1 AND locale IS DISTINCT FROM $2
     RETURNING id, email, display_name, password_hash, locale, created_at`,
    [userId, locale],
  );
  if ((result.rowCount ?? 0) === 0) return null;
  return mapRow(requireSingleRow(result.rows, "users row"));
}
