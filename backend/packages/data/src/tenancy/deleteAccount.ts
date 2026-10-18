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
import { transitionTenantStatus, TENANT_STATUSES } from "./tenantsStore.js";
import { publishTenantDeactivated } from "./tenantStatusSignal.js";

/**
 * Raised when the password given to confirm an account deletion does not match, or the
 * email+IP pair is locked out. Deliberately not a 401, so the web client's "401 means signed out"
 * handling is not triggered by a typo.
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
 * Starts the deletion of a tenant on the caller's client, so every step commits or rolls back
 * together: `active`/`suspended` → `deleting`, every session and push registration of the tenant's
 * users revoked, the tenant's `tenant_keys` row deleted, and the deactivation signal published.
 *
 * Crypto-shred guarantee: once this transaction commits, the tenant's wrapped data key no longer
 * exists, so every credential sealed under it (`scheme = 'tenant'`) is undecryptable, including in
 * backups taken after the commit. Credentials sealed under the master key (`scheme = 'master'`) are
 * not covered; sealing new credentials under the tenant key is delivered by later issues.
 *
 * Must run inside `runInTenant(tenantId, …)`, because `tenant_keys` is only reachable from its own
 * tenant's scope; any other scope throws before any write.
 */
export async function beginTenantDeletion(client: PoolClient, tenantId: string): Promise<void> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant" || scope.tenantId !== tenantId.toLowerCase()) {
    throw new Error("beginTenantDeletion must run inside runInTenant for the tenant being deleted");
  }
  await transitionTenantStatus(client, tenantId, ["active", "suspended"], "deleting");
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM users WHERE COALESCE(tenant_id, app_sole_tenant()) = $1 ORDER BY id",
    [tenantId],
  );
  for (const user of rows) {
    await revokeAllSessionsForUser(client, user.id);
    await revokeAllPushSubscriptionsForUser(client, user.id);
  }
  // Zero rows is legitimate: a tenant that never stored a credential has no key.
  await client.query("DELETE FROM tenant_keys WHERE tenant_id = $1", [tenantId]);
  await publishTenantDeactivated(client, tenantId);
}

/**
 * Takes the admin-membership lock, re-reads the user `FOR UPDATE` and applies the last-admin guard
 * when the user currently counts as an active admin. Returns the user's tenant id.
 */
async function lockUserAndGuardLastAdmin(client: PoolClient, userId: string): Promise<string> {
  await lockAdminMembership(client);
  const { rows } = await client.query<{ tenant_id: string; role: string; status: string }>(
    `SELECT t.id AS tenant_id, u.role, t.status
       FROM users u
       JOIN tenants t ON t.id = COALESCE(u.tenant_id, app_sole_tenant())
      WHERE u.id = $1
        FOR UPDATE OF u`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("Account not found", { userId });
  const role = assertKnownValue(USER_ROLES, row.role, "users.role");
  const status = assertKnownValue(TENANT_STATUSES, row.status, "tenants.status");
  if (role === "admin" && status === "active") await assertAnotherActiveAdminRemains(client, userId);
  return row.tenant_id;
}

export interface DeleteOwnAccountInput {
  userId: string;
  tenantId: string;
  password: string;
  ip: string;
}

/**
 * Deletes the caller's own account after re-entering their password. Applies `login`'s lockout
 * check and timing-safe verification: a locked email+IP pair or a wrong password records a failed
 * attempt on the pool (auto-committed, so it survives the throw) and throws
 * `ReauthenticationFailedError`. Then, in one transaction in the tenant's scope, takes the admin
 * membership lock, refuses with `LastAdminError` for the last active admin and runs
 * `beginTenantDeletion`. No audit row is written for a self-deletion.
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
      const tenantId = await lockUserAndGuardLastAdmin(client, input.userId);
      await beginTenantDeletion(client, tenantId);
    }),
  );
}

export interface DeleteAccountAsAdminInput {
  actorUserId: string;
  targetUserId: string;
}

/**
 * Deletes any other account on an admin's behalf. An admin's own account is refused with
 * `SelfDeletionRequiresReauthenticationError` before any query: it goes through `deleteOwnAccount`
 * with password re-authentication. The target's tenant is resolved from `users`, then one
 * transaction in that tenant's scope takes the admin membership lock, refuses with `LastAdminError`
 * for the last active admin, runs `beginTenantDeletion` and records `accountDeletionRequested`.
 * Enters the tenant only for that write transaction and reads none of its content. Returns the
 * account's summary after the commit.
 */
export async function deleteAccountAsAdmin(pool: Pool, input: DeleteAccountAsAdminInput): Promise<AdminAccountSummary> {
  if (input.targetUserId === input.actorUserId) throw new SelfDeletionRequiresReauthenticationError();
  const { rows } = await pool.query<{ tenant_id: string }>(
    "SELECT COALESCE(tenant_id, app_sole_tenant()) AS tenant_id FROM users WHERE id = $1",
    [input.targetUserId],
  );
  const targetTenantId = rows[0]?.tenant_id;
  if (!targetTenantId) throw new NotFoundError("Account not found", { userId: input.targetUserId });

  await runInTenant(targetTenantId, () =>
    withTransaction(pool, async (client) => {
      const tenantId = await lockUserAndGuardLastAdmin(client, input.targetUserId);
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
