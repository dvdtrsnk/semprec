import type { Pool, PoolClient } from "pg";
import type { UserRole } from "../auth/types.js";
import { ChokePointError, NotFoundError } from "../errors.js";

export type TenantStatus = "provisioning" | "active" | "suspended" | "deleting";

export const TENANT_STATUSES: readonly TenantStatus[] = ["provisioning", "active", "suspended", "deleting"];
const USER_ROLES: readonly UserRole[] = ["admin", "member"];

export function isTenantStatus(value: unknown): value is TenantStatus {
  return typeof value === "string" && (TENANT_STATUSES as readonly string[]).includes(value);
}

function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

/**
 * The id of the only tenant, via `app_sole_tenant()`. While the single-tenant guard exists a
 * missing sole tenant is an invariant violation, so it surfaces as a plain `Error` (a 500), never a domain error.
 */
export async function getSoleTenantId(client: Pool | PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string | null }>("SELECT app_sole_tenant() AS id");
  const id = rows[0]?.id;
  if (!id) throw new Error("Expected exactly one tenant, found none or several");
  return id;
}

/**
 * The tenant a user belongs to, with that tenant's status and the user's role. A user with no
 * `tenant_id` resolves to the sole tenant while exactly one exists. Returns `null` when the user
 * is unbound and no sole tenant exists, or the user does not exist. An unknown `status` or `role`
 * is a data-integrity failure and throws a plain `Error` (a 500), never a 401.
 *
 * The `app_sole_tenant()` fallback is the transitional contract of the tenancy rollout: it is
 * required by the issue and ends when `users.tenant_id` becomes NOT NULL (#1067).
 */
export async function getUserTenantBinding(
  client: Pool | PoolClient,
  userId: string,
): Promise<{ tenantId: string; status: TenantStatus; role: UserRole } | null> {
  const { rows } = await client.query<{ id: string; status: unknown; role: unknown }>(
    "SELECT t.id, t.status, u.role FROM users u JOIN tenants t ON t.id = COALESCE(u.tenant_id, app_sole_tenant()) WHERE u.id = $1",
    [userId],
  );
  const row = rows[0];
  if (!row) return null;
  if (!isTenantStatus(row.status)) throw new Error("Unknown value in column tenants.status");
  if (!isUserRole(row.role)) throw new Error("Unknown value in column users.role");
  return { tenantId: row.id, status: row.status, role: row.role };
}

/**
 * `getUserTenantBinding` for a caller about to write on the strength of the answer (a session,
 * a reset token, a new password hash). It locks the user row `FOR KEY SHARE` and then the tenant
 * row `FOR SHARE`, in the order the admin mutations lock them, so a concurrent `suspendAccount`
 * either commits first and is seen here, or waits for the caller's transaction to commit and then
 * revokes what it wrote (docs/adr/2026-10-17-admin-membership-and-tenant-status-writes.md).
 */
export async function lockUserTenantBinding(
  client: PoolClient,
  userId: string,
): Promise<{ tenantId: string; status: TenantStatus; role: UserRole } | null> {
  const user = await client.query<{ tenant_id: string | null; role: unknown }>(
    "SELECT COALESCE(tenant_id, app_sole_tenant()) AS tenant_id, role FROM users WHERE id = $1 FOR KEY SHARE",
    [userId],
  );
  const userRow = user.rows[0];
  if (!userRow?.tenant_id) return null;
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
 * The only writer of `tenants.status` after provisioning: one conditional `UPDATE` moves the
 * tenant to `to` when its current status is in `from`. Runs on the caller's client, so the change
 * commits or rolls back with the caller's transaction. When no row matches, an existing tenant
 * answers 409 `invalid_account_status` and a missing one `NotFoundError`. The single-writer
 * rule and the lock order its callers follow are recorded in
 * docs/adr/2026-10-17-admin-membership-and-tenant-status-writes.md.
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
