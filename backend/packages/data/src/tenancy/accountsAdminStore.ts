import type { PoolClient } from "pg";
import type { UserRole } from "../auth/types.js";
import { assertKnownValue } from "../dbRowValidation.js";
import type { Queryable } from "../db/pool.js";
import type { TenantStatus } from "./tenantsStore.js";

/**
 * Admin-plane reads and the audit log. Everything here touches global tables only (`users`,
 * `tenants`, `sessions`, `admin_audit_log`), never a tenant's rows, and runs in system scope
 * (docs/adr/2026-10-17-admin-role-without-content-access.md).
 */

const USER_ROLES: readonly UserRole[] = ["admin", "member"];
const TENANT_STATUSES: readonly TenantStatus[] = ["provisioning", "active", "suspended", "deleting"];

export interface AdminAccountSummary {
  userId: string;
  email: string;
  role: UserRole;
  status: TenantStatus;
  createdAt: string;
  /** The newest `sessions.last_seen_at` of the user; `null` for a user who never had a session. */
  lastSeenAt: string | null;
}

interface AdminAccountRow {
  user_id: string;
  email: string;
  role: string;
  status: string;
  created_at: Date;
  last_seen_at: Date | null;
}

/**
 * Every account, oldest first. A user without `tenant_id` binds to the sole tenant, the same
 * fallback as `getUserTenantBinding`.
 */
export async function listAccounts(client: Queryable): Promise<AdminAccountSummary[]> {
  const { rows } = await client.query<AdminAccountRow>(
    `SELECT u.id AS user_id, u.email, u.role, t.status, u.created_at, max(s.last_seen_at) AS last_seen_at
       FROM users u
       JOIN tenants t ON t.id = COALESCE(u.tenant_id, app_sole_tenant())
       LEFT JOIN sessions s ON s.user_id = u.id
      GROUP BY u.id, u.email, u.role, t.status, u.created_at
      ORDER BY u.created_at, u.id`,
  );
  return rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    role: assertKnownValue(USER_ROLES, row.role, "users.role"),
    status: assertKnownValue(TENANT_STATUSES, row.status, "tenants.status"),
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
  }));
}

/** The actions the admin routes record; each sibling issue of the multi-tenant accounts batch writes one or more. */
export const ADMIN_AUDIT_ACTIONS = [
  "tenantAiBudgetSet",
  "inviteCreated",
  "inviteRevoked",
  "accountSuspended",
  "accountReactivated",
  "accountRoleChanged",
  "accountDeletionRequested",
] as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];

export interface AdminActionInput {
  actorUserId: string;
  action: AdminAuditAction;
  targetTenantId: string | null;
  details?: Record<string, string | number | boolean | null>;
}

/**
 * Appends one `admin_audit_log` row on the caller's client, so the row commits or rolls back with
 * the mutation it records. `details` holds ids and scalars only: never tenant content and never an
 * email address. `action` is re-checked at runtime because callers may hold a widened string.
 */
export async function recordAdminAction(client: PoolClient, input: AdminActionInput): Promise<void> {
  const action = assertKnownValue(ADMIN_AUDIT_ACTIONS, input.action, "admin audit action");
  await client.query(
    "INSERT INTO admin_audit_log (actor_user_id, action, target_tenant_id, details) VALUES ($1, $2, $3, $4::jsonb)",
    [input.actorUserId, action, input.targetTenantId, JSON.stringify(input.details ?? {})],
  );
}
