import type { Pool, PoolClient } from "pg";
import type { UserRole } from "../auth/types.js";

export type TenantStatus = "provisioning" | "active" | "suspended" | "deleting";

const TENANT_STATUSES: readonly TenantStatus[] = ["provisioning", "active", "suspended", "deleting"];
const USER_ROLES: readonly UserRole[] = ["admin", "member"];

function isTenantStatus(value: unknown): value is TenantStatus {
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
