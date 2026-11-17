import type { Pool, PoolClient } from "pg";
import { currentTenantScope, runInTenant } from "@semprec/shared";
import { normalizeEmail } from "../auth/emailNormalization.js";
import { getFailureStreak, recordLoginAttempt } from "../auth/loginAttemptsStore.js";
import { lockoutDurationSeconds } from "../auth/loginLockout.js";
import { verifyPassword } from "../auth/passwordHash.js";
import { revokeAllSessionsForUser } from "../auth/sessionsStore.js";
import { getUserById } from "../auth/usersStore.js";
import type { UserRole } from "../auth/types.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError, NotFoundError } from "../errors.js";
import { revokeAllPushSubscriptionsForUser } from "../push/pushSubscriptionsStore.js";
import {
  assertAnotherActiveAdminRemains,
  getAccountSummary,
  lockAdminMembership,
  recordAdminAction,
  type AdminAccountSummary,
} from "./accountsAdminStore.js";
import { logger } from "./logger.js";
import { transitionTenantStatus, TENANT_STATUSES } from "./tenantsStore.js";
import { publishTenantDeactivated } from "./tenantStatusSignal.js";

/**
 * Wrong or stale password, or lockout, on account deletion or `changePassword`. Not a 401, so a typo does
 * not trigger the web client's signed-out handling.
 */
export class ReauthenticationFailedError extends ChokePointError {
  constructor() {
    super(403, "reauthentication_failed", "Password is incorrect");
    this.name = "ReauthenticationFailedError";
  }
}

/** Raised when an admin tries to delete their own account through the admin route. */
export class SelfDeletionRequiresReauthenticationError extends ChokePointError {
  constructor() {
    super(403, "self_deletion_requires_reauthentication", "Delete your own account through the account page");
    this.name = "SelfDeletionRequiresReauthenticationError";
  }
}

const USER_ROLES: readonly UserRole[] = ["admin", "member"];

/**
 * Starts a tenant's deletion in the caller's transaction: `deleting`, sessions and push registrations
 * revoked, `tenant_keys` deleted (crypto-shred of tenant-sealed credentials), deactivation published. Must
 * run inside `runInTenant(tenantId, …)`, the only scope that reaches `tenant_keys`.
 */
export async function beginTenantDeletion(client: PoolClient, tenantId: string): Promise<void> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant" || scope.tenantId !== tenantId.toLowerCase()) {
    throw new Error("beginTenantDeletion must run inside runInTenant for the tenant being deleted");
  }
  await transitionTenantStatus(client, tenantId, ["active", "suspended"], "deleting");
  const { rows } = await client.query<{ id: string }>("SELECT id FROM users WHERE tenant_id = $1 ORDER BY id", [
    tenantId,
  ]);
  for (const user of rows) {
    await revokeAllSessionsForUser(client, user.id);
    await revokeAllPushSubscriptionsForUser(client, user.id);
  }
  // Zero rows is legitimate: a tenant that never stored a credential has no key.
  const shredded = await client.query("DELETE FROM tenant_keys WHERE tenant_id = $1", [tenantId]);
  logger.info({ tenantId, keyDeleted: (shredded.rowCount ?? 0) > 0 }, "tenant_deletion_begun");
  await publishTenantDeactivated(client, tenantId);
}

/** Admin lock, user `FOR UPDATE`, last-admin guard; returns tenant id and password hash as seen under the lock. */
async function lockUserAndGuardLastAdmin(
  client: PoolClient,
  userId: string,
): Promise<{ tenantId: string; passwordHash: string }> {
  await lockAdminMembership(client);
  const { rows } = await client.query<{ tenant_id: string; role: string; status: string; password_hash: string }>(
    `SELECT t.id AS tenant_id, u.role, t.status, u.password_hash
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = $1
        FOR UPDATE OF u`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Account not found", { userId });
  const role = assertKnownValue(USER_ROLES, row.role, "users.role");
  const status = assertKnownValue(TENANT_STATUSES, row.status, "tenants.status");
  if (role === "admin" && status === "active") await assertAnotherActiveAdminRemains(client, userId);
  return { tenantId: row.tenant_id, passwordHash: row.password_hash };
}

export interface DeleteOwnAccountInput {
  userId: string;
  tenantId: string;
  password: string;
  ip: string;
}

/**
 * Password re-entry with `login`'s lockout and timing-safe check; a failure records an auto-committed attempt.
 * Then one transaction refuses the last active admin, rejects a hash changed since, and begins deletion.
 */
export async function deleteOwnAccount(pool: Pool, input: DeleteOwnAccountInput): Promise<void> {
  const user = await getUserById(pool, input.userId);
  if (!user) throw new NotFoundError("Account not found", { userId: input.userId });
  const email = normalizeEmail(user.email);

  const streak = await getFailureStreak(pool, email, input.ip);
  let locked = false;
  if (streak.lastFailedAt) {
    const lockedUntil = new Date(streak.lastFailedAt).getTime() + lockoutDurationSeconds(streak.count) * 1000;
    locked = Date.now() < lockedUntil;
  }
  // A locked pair skips verification, exactly as `login` does.
  const passwordOk = !locked && (await verifyPassword(user.passwordHash, input.password));
  if (locked || !passwordOk) {
    await recordLoginAttempt(pool, { email, ip: input.ip, succeeded: false });
    throw new ReauthenticationFailedError();
  }

  await runInTenant(input.tenantId, () =>
    withTransaction(pool, async (client) => {
      const locked = await lockUserAndGuardLastAdmin(client, input.userId);
      // A password change committed since verification replaced the hash, so the verified credential is stale.
      if (locked.passwordHash !== user.passwordHash) throw new ReauthenticationFailedError();
      await beginTenantDeletion(client, locked.tenantId);
    }),
  );
}

export interface DeleteAccountAsAdminInput {
  actorUserId: string;
  targetUserId: string;
}

/**
 * Deletes another account (the admin's own must use `deleteOwnAccount`): refuses the last active admin, begins
 * deletion and records `accountDeletionRequested`, reading only identity rows.
 */
export async function deleteAccountAsAdmin(pool: Pool, input: DeleteAccountAsAdminInput): Promise<AdminAccountSummary> {
  if (input.targetUserId === input.actorUserId) throw new SelfDeletionRequiresReauthenticationError();
  const { rows } = await pool.query<{ tenant_id: string }>("SELECT tenant_id FROM users WHERE id = $1", [
    input.targetUserId,
  ]);
  const targetTenantId = rows[0]?.tenant_id;
  if (!targetTenantId) throw new NotFoundError("Account not found", { userId: input.targetUserId });

  await runInTenant(targetTenantId, () =>
    withTransaction(pool, async (client) => {
      const { tenantId } = await lockUserAndGuardLastAdmin(client, input.targetUserId);
      await beginTenantDeletion(client, tenantId);
      await recordAdminAction(client, {
        actorUserId: input.actorUserId,
        action: "accountDeletionRequested",
        targetTenantId: tenantId,
        details: {},
      });
    }),
  );
  return getAccountSummary(pool, input.targetUserId);
}
