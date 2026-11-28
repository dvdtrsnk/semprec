import type { PoolClient } from "pg";
import type { UserRole } from "../auth/types.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { requireAffectedRows, type Queryable } from "../db/pool.js";
import { ChokePointError, NotFoundError } from "../errors.js";
import { revokeAllSessionsForUser } from "../auth/sessionsStore.js";
import { revokeAllPushSubscriptionsForUser } from "../push/pushSubscriptionsStore.js";
import { transitionTenantStatus, type TenantStatus } from "./tenantsStore.js";
import { publishTenantDeactivated } from "./tenantStatusSignal.js";

/**
 * Admin-plane reads and the audit log. Touches only global tables (`users`, `tenants`, `sessions`,
 * `admin_audit_log`), never a tenant's rows, in system scope.
 */

const USER_ROLES: readonly UserRole[] = ["admin", "member"];
const TENANT_STATUSES: readonly TenantStatus[] = ["provisioning", "active", "suspended", "deleting"];

export interface AdminAccountSummary {
  userId: string;
  email: string;
  role: UserRole;
  status: TenantStatus;
  createdAt: string;
  /** `null` for a user who never had a session. */
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

const ACCOUNT_SELECT = `SELECT u.id AS user_id, u.email, u.role, t.status, u.created_at, max(s.last_seen_at) AS last_seen_at
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       LEFT JOIN sessions s ON s.user_id = u.id`;
const ACCOUNT_GROUP = "GROUP BY u.id, u.email, u.role, t.status, u.created_at";

function toAccountSummary(row: AdminAccountRow): AdminAccountSummary {
  return {
    userId: row.user_id,
    email: row.email,
    role: assertKnownValue(USER_ROLES, row.role, "users.role"),
    status: assertKnownValue(TENANT_STATUSES, row.status, "tenants.status"),
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
  };
}

/** Oldest first; each status is that of the account's tenant. */
export async function listAccounts(client: Queryable): Promise<AdminAccountSummary[]> {
  const { rows } = await client.query<AdminAccountRow>(
    `${ACCOUNT_SELECT} ${ACCOUNT_GROUP} ORDER BY u.created_at, u.id`,
  );
  return rows.map(toAccountSummary);
}

export async function getAccountSummary(client: Queryable, userId: string): Promise<AdminAccountSummary> {
  const { rows } = await client.query<AdminAccountRow>(`${ACCOUNT_SELECT} WHERE u.id = $1 ${ACCOUNT_GROUP}`, [userId]);
  const row = rows[0];
  if (!row) throw new NotFoundError("Account not found", { userId });
  return toAccountSummary(row);
}

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
 * On the caller's client, so the row commits with the mutation it records. `details` holds ids and
 * scalars only, never tenant content or email addresses. `action` is re-checked at runtime because
 * callers may hold a widened string.
 */
export async function recordAdminAction(client: PoolClient, input: AdminActionInput): Promise<void> {
  const action = assertKnownValue(ADMIN_AUDIT_ACTIONS, input.action, "admin audit action");
  await client.query(
    "INSERT INTO admin_audit_log (actor_user_id, action, target_tenant_id, details) VALUES ($1, $2, $3, $4::jsonb)",
    [input.actorUserId, action, input.targetTenantId, JSON.stringify(input.details ?? {})],
  );
}

export class LastAdminError extends ChokePointError {
  constructor() {
    super(409, "last_admin", "At least one active admin must remain");
    this.name = "LastAdminError";
  }
}

/**
 * Serializes admin-membership mutations for the rest of the transaction. Take it before reading the
 * target row so the guard's count cannot go stale.
 */
export async function lockAdminMembership(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('alldots_admin_membership'))");
}

/** Throws `LastAdminError` when no other admin belongs to an `active` tenant; only meaningful under `lockAdminMembership`. */
export async function assertAnotherActiveAdminRemains(client: PoolClient, userId: string): Promise<void> {
  const { rows } = await client.query<{ remaining: string }>(
    `SELECT count(*) AS remaining
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
      WHERE u.role = 'admin' AND t.status = 'active' AND u.id <> $1`,
    [userId],
  );
  if (Number(rows[0]?.remaining ?? 0) === 0) throw new LastAdminError();
}

export interface AccountMutationInput {
  actorUserId: string;
  targetUserId: string;
}

interface LockedTarget {
  tenantId: string;
  role: UserRole;
  status: TenantStatus;
  isActiveAdmin: boolean;
}

/** Takes the membership lock, then reads the target's user row `FOR UPDATE`. */
async function lockTarget(client: PoolClient, targetUserId: string): Promise<LockedTarget> {
  await lockAdminMembership(client);
  const { rows } = await client.query<{ tenant_id: string; role: string; status: string }>(
    `SELECT t.id AS tenant_id, u.role, t.status
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = $1
        FOR UPDATE OF u`,
    [targetUserId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Account not found", { userId: targetUserId });
  const role = assertKnownValue(USER_ROLES, row.role, "users.role");
  const status = assertKnownValue(TENANT_STATUSES, row.status, "tenants.status");
  return { tenantId: row.tenant_id, role, status, isActiveAdmin: role === "admin" && status === "active" };
}

/**
 * Suspends the account's tenant, publishes the deactivation signal, revokes sessions and push
 * registrations and records `accountSuspended`, in the caller's transaction. Refuses the last active admin.
 */
export async function suspendAccount(client: PoolClient, input: AccountMutationInput): Promise<AdminAccountSummary> {
  const target = await lockTarget(client, input.targetUserId);
  if (target.isActiveAdmin) await assertAnotherActiveAdminRemains(client, input.targetUserId);
  await transitionTenantStatus(client, target.tenantId, ["active"], "suspended");
  await publishTenantDeactivated(client, target.tenantId);
  await revokeAllSessionsForUser(client, input.targetUserId);
  await revokeAllPushSubscriptionsForUser(client, input.targetUserId);
  await recordAdminAction(client, {
    actorUserId: input.actorUserId,
    action: "accountSuspended",
    targetTenantId: target.tenantId,
  });
  return getAccountSummary(client, input.targetUserId);
}

/** `suspended` → `active` and records `accountReactivated`; sessions stay revoked. */
export async function reactivateAccount(client: PoolClient, input: AccountMutationInput): Promise<AdminAccountSummary> {
  const target = await lockTarget(client, input.targetUserId);
  await transitionTenantStatus(client, target.tenantId, ["suspended"], "active");
  await recordAdminAction(client, {
    actorUserId: input.actorUserId,
    action: "accountReactivated",
    targetTenantId: target.tenantId,
  });
  return getAccountSummary(client, input.targetUserId);
}

/**
 * An unchanged role returns without an audit row; demoting an active admin applies the last-admin guard;
 * otherwise records `accountRoleChanged` with `{ from, to }`.
 */
export async function changeAccountRole(
  client: PoolClient,
  input: AccountMutationInput & { role: UserRole },
): Promise<AdminAccountSummary> {
  const role = assertKnownValue(USER_ROLES, input.role, "users.role");
  const target = await lockTarget(client, input.targetUserId);
  if (target.role === role) return getAccountSummary(client, input.targetUserId);
  if (target.isActiveAdmin && role === "member") await assertAnotherActiveAdminRemains(client, input.targetUserId);
  const result = await client.query("UPDATE users SET role = $2 WHERE id = $1", [input.targetUserId, role]);
  requireAffectedRows(result, "the role update");
  await recordAdminAction(client, {
    actorUserId: input.actorUserId,
    action: "accountRoleChanged",
    targetTenantId: target.tenantId,
    details: { from: target.role, to: role },
  });
  return getAccountSummary(client, input.targetUserId);
}
