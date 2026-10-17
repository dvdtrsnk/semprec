import type { Pool, PoolClient } from "pg";
import { requireSingleRow } from "../db/pool.js";
import type { UserRole, UserRow } from "./types.js";
import { isTenantStatus, type TenantStatus } from "../tenancy/tenantsStore.js";

/** The raw `users` row shape this module reads back from Postgres. */
type UserDbRow = { id: string; email: string; password_hash: string; locale: string; created_at: Date };

function mapRow(row: UserDbRow): UserRow {
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
  /** Defaults to NULL (no tenant) when omitted. */
  tenantId?: string;
  /** Defaults to the `users.role` column default (`member`) when omitted. */
  role?: UserRole;
}

/** Throws (unique violation, Postgres error code `23505`) if `email` is already taken. */
export async function createUser(client: Pool | PoolClient, input: CreateUserInput): Promise<UserRow> {
  const columns = ["email", "password_hash"];
  const values: unknown[] = [input.email, input.passwordHash];
  const optional: [string, unknown][] = [
    ["locale", input.locale],
    ["tenant_id", input.tenantId],
    ["role", input.role],
  ];
  for (const [column, value] of optional) {
    if (value === undefined) continue;
    columns.push(column);
    values.push(value);
  }
  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await client.query<UserDbRow>(
    `INSERT INTO users (${columns.join(", ")}) VALUES (${placeholders})
     RETURNING id, email, password_hash, locale, created_at`,
    values,
  );
  return mapRow(requireSingleRow(rows, "users row"));
}

export async function getUserByEmail(client: Pool | PoolClient, email: string): Promise<UserRow | null> {
  const { rows } = await client.query<UserDbRow>(
    `SELECT id, email, password_hash, locale, created_at FROM users WHERE email = $1`,
    [email],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * `getUserByEmail` plus the status of the tenant the user is bound to, read in one statement so
 * a login for an unknown email makes the same database round trips as one for a registered email.
 * The tenant resolves like `getUserTenantBinding` (`users.tenant_id`, else the sole tenant);
 * `tenantStatus` is `null` when no tenant resolves. An unknown status throws a plain `Error`.
 */
export async function getUserByEmailWithTenantStatus(
  client: Pool | PoolClient,
  email: string,
): Promise<{ user: UserRow; tenantStatus: TenantStatus | null } | null> {
  const { rows } = await client.query<UserDbRow & { tenant_status: unknown }>(
    `SELECT u.id, u.email, u.password_hash, u.locale, u.created_at, t.status AS tenant_status
       FROM users u LEFT JOIN tenants t ON t.id = COALESCE(u.tenant_id, app_sole_tenant())
      WHERE u.email = $1`,
    [email],
  );
  const row = rows[0];
  if (!row) return null;
  const status = row.tenant_status;
  if (status === null) return { user: mapRow(row), tenantStatus: null };
  if (!isTenantStatus(status)) throw new Error("Unknown value in column tenants.status");
  return { user: mapRow(row), tenantStatus: status };
}

export async function getUserById(client: Pool | PoolClient, id: string): Promise<UserRow | null> {
  const { rows } = await client.query<UserDbRow>(
    `SELECT id, email, password_hash, locale, created_at FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Backs the setup API's (#233) "no account exists yet" gate — cheaper than a `count(*)` since it can stop at the first row. */
export async function anyUserExists(client: Pool | PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(`SELECT EXISTS(SELECT 1 FROM users) AS "exists"`);
  return rows[0]?.exists ?? false;
}

/**
 * The recipient of a tenant event is the user of the scope's tenant: the account whose
 * `users.tenant_id` is `app_tenant_default()` (the scope's tenant, or the sole tenant when no
 * scope is set and only one tenant exists). Returns `null` when the tenant has no bound user,
 * and in a system scope once more than one tenant exists — the same visibility tenant rows have.
 */
export async function getTenantUserId(client: Pool | PoolClient): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE tenant_id = (SELECT app_tenant_default())`,
  );
  return rows[0] ? rows[0].id : null;
}

/**
 * Every admin of an active tenant, oldest account first — the recipients of an operator alert.
 * Reads across tenants, so the caller must be in a system scope. Admins of suspended, provisioning
 * or deleting tenants are skipped.
 */
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

/**
 * Locale of the tenant's user — the recipient rule of `getTenantUserId`: the user of the scope's
 * tenant. Returns `null` when the tenant has no bound user, and in a system scope once more
 * than one tenant exists.
 */
export async function getTenantUserLocale(client: Pool | PoolClient): Promise<string | null> {
  const { rows } = await client.query<{ locale: string }>(
    `SELECT locale FROM users WHERE tenant_id = (SELECT app_tenant_default())`,
  );
  return rows[0] ? rows[0].locale : null;
}

/** Used by `resetPassword` (auth/passwordResetActions.ts) to replace a user's password hash after a reset token is consumed. */
export async function updateUserPasswordHash(
  client: Pool | PoolClient,
  id: string,
  passwordHash: string,
): Promise<void> {
  await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, id]);
}
