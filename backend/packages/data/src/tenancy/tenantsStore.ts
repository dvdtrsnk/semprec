import type { Pool, PoolClient } from "pg";
import type { UserRole, UserRow } from "../auth/types.js";
import { requireSingleRow } from "../db/pool.js";
import { ChokePointError, NotFoundError } from "../errors.js";

export type TenantStatus = "provisioning" | "active" | "suspended" | "deleting";

export const TENANT_STATUSES: readonly TenantStatus[] = ["provisioning", "active", "suspended", "deleting"];
const USER_ROLES: readonly UserRole[] = ["admin", "member"];

function isTenantStatus(value: unknown): value is TenantStatus {
  return typeof value === "string" && (TENANT_STATUSES as readonly string[]).includes(value);
}

function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

/** The database generates the id. Invitation acceptance creates `provisioning`; `provisionTenant` activates it. */
export async function createTenant(client: PoolClient, status: TenantStatus): Promise<string> {
  const { rows } = await client.query<{ id: string }>("INSERT INTO tenants (status) VALUES ($1) RETURNING id", [
    status,
  ]);
  return requireSingleRow(rows, "tenants insert").id;
}

/** With an id the caller chose, so it can enter the tenant's scope before the row exists. */
export async function createTenantWithId(client: PoolClient, id: string, status: TenantStatus): Promise<void> {
  const { rows } = await client.query<{ id: string }>("INSERT INTO tenants (id, status) VALUES ($1, $2) RETURNING id", [
    id,
    status,
  ]);
  requireSingleRow(rows, "tenants insert");
}

/**
 * Via `app_sole_tenant()`. While the single-tenant guard exists a missing sole tenant is an invariant
 * violation, so it is a plain `Error` (500), never a domain error.
 */
export async function getSoleTenantId(client: Pool | PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string | null }>("SELECT app_sole_tenant() AS id");
  const id = rows[0]?.id;
  if (!id) throw new Error("Expected exactly one tenant, found none or several");
  return id;
}

/**
 * The user's tenant (`users.tenant_id`, NOT NULL) with its status and the user's role; `null` for an
 * unknown user. An unknown `status` or `role` throws a plain `Error` (500), never a 401.
 */
export async function getUserTenantBinding(
  client: Pool | PoolClient,
  userId: string,
): Promise<{ tenantId: string; status: TenantStatus; role: UserRole } | null> {
  const { rows } = await client.query<{ id: string; status: unknown; role: unknown }>(
    "SELECT t.id, t.status, u.role FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1",
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  if (!isTenantStatus(row.status)) throw new Error("Unknown value in column tenants.status");
  if (!isUserRole(row.role)) throw new Error("Unknown value in column users.role");
  return { tenantId: row.id, status: row.status, role: row.role };
}

/**
 * One statement, so a login for an unknown email makes the same round trips as for a registered one.
 * `tenantStatus` is `null` when the tenant row is missing; an unknown status throws.
 */
export async function getUserByEmailWithTenantStatus(
  client: Pool | PoolClient,
  email: string,
): Promise<{ user: UserRow; tenantStatus: TenantStatus | null } | null> {
  const { rows } = await client.query<{
    id: string;
    email: string;
    display_name: string | null;
    password_hash: string;
    locale: string;
    created_at: Date;
    tenant_status: unknown;
  }>(
    `SELECT u.id, u.email, u.display_name, u.password_hash, u.locale, u.created_at, t.status AS tenant_status
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.email = $1`,
    [email],
  );
  const row = rows[0];
  if (!row) return null;
  const user: UserRow = {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    locale: row.locale,
    createdAt: row.created_at.toISOString(),
  };
  if (row.tenant_status === null) return { user, tenantStatus: null };
  if (!isTenantStatus(row.tenant_status)) throw new Error("Unknown value in column tenants.status");
  return { user, tenantStatus: row.tenant_status };
}

/**
 * `getUserTenantBinding` for a caller about to write on its answer (a session, reset token, password
 * hash). Locks the user `FOR KEY SHARE` then the tenant `FOR SHARE`, the admin mutations' order, so a
 * concurrent `suspendAccount` either commits first and is seen, or waits and then revokes what was written.
 */
export async function lockUserTenantBinding(
  client: PoolClient,
  userId: string,
): Promise<{ tenantId: string; status: TenantStatus; role: UserRole } | null> {
  const user = await client.query<{ tenant_id: string; role: unknown }>(
    "SELECT tenant_id, role FROM users WHERE id = $1 FOR KEY SHARE",
    [userId],
  );
  const userRow = user.rows[0];
  if (!userRow) return null;
  const tenant = await client.query<{ status: unknown }>("SELECT status FROM tenants WHERE id = $1 FOR SHARE", [
    userRow.tenant_id,
  ]);
  const tenantRow = tenant.rows[0];
  if (!tenantRow) return null;
  if (!isTenantStatus(tenantRow.status)) throw new Error("Unknown value in column tenants.status");
  if (!isUserRole(userRow.role)) throw new Error("Unknown value in column users.role");
  return { tenantId: userRow.tenant_id, status: tenantRow.status, role: userRow.role };
}

/**
 * The only writer of `tenants.status` after provisioning: one conditional `UPDATE` from any of `from` to
 * `to`, in the caller's transaction. No match: an existing tenant is 409 `invalid_account_status`, a
 * missing one `NotFoundError`.
 */
export async function transitionTenantStatus(
  client: PoolClient,
  tenantId: string,
  from: readonly TenantStatus[],
  to: TenantStatus,
): Promise<{ id: string; status: TenantStatus; statusChangedAt: string }> {
  const result = await client.query<{ id: string; status: unknown; status_changed_at: Date }>(
    `UPDATE tenants SET status = $3, status_changed_at = now()
      WHERE id = $1 AND status = ANY($2::text[])
      RETURNING id, status, status_changed_at`,
    [tenantId, from, to],
  );
  const row = result.rows[0];
  if (result.rowCount !== 0 && row) {
    if (!isTenantStatus(row.status)) throw new Error("Unknown value in column tenants.status");
    return { id: row.id, status: row.status, statusChangedAt: row.status_changed_at.toISOString() };
  }
  const existing = await client.query<{ id: string }>("SELECT id FROM tenants WHERE id = $1", [tenantId]);
  if (existing.rows.length === 0) throw new NotFoundError("Tenant not found", { tenantId });
  throw new ChokePointError(
    409,
    "invalid_account_status",
    `Account status cannot change to ${to} from its current status`,
  );
}
