// A transaction-scoped advisory lock keyed by tenant and id, for guards that order whole operations on one record
// (a mailbox's sync passes and removal, an account's calendar sync passes and Calendars switch).
import type { PoolClient } from "pg";
import { currentTenantScope, TenantScopeMissingError } from "@semprec/shared";

/** `lock_not_available`, raised when `lock_timeout` ends a wait. */
const LOCK_NOT_AVAILABLE = "55P03";

function isLockNotAvailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === LOCK_NOT_AVAILABLE;
}

export interface TenantAdvisoryGuardOptions {
  /** Without it only the pool's statement timeout bounds the wait. */
  maxWaitMs?: number;
}

/**
 * Held until the caller's transaction ends. The key is `<namespace>:<tenant>:<id>`, so other tenants never wait;
 * `label` names the guard in error messages.
 * Requires a READ COMMITTED tenant transaction: otherwise the lock would not order the caller against a holder that
 * committed while it waited.
 *
 * `maxWaitMs` sets a transaction-local `lock_timeout` and restores it right after the grant so no later statement
 * inherits it. On timeout the transaction is aborted and `busy()` is thrown.
 */
export async function lockTenantAdvisoryGuard(
  client: PoolClient,
  guard: { label: string; namespace: string; busy: () => Error },
  id: string,
  options: TenantAdvisoryGuardOptions,
): Promise<void> {
  const { label, namespace, busy } = guard;
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new TenantScopeMissingError(`The ${label} guard requires a tenant scope`);
  const notInTenantTransaction = `The ${label} guard requires a READ COMMITTED tenant transaction`;
  const { maxWaitMs } = options;
  if (maxWaitMs !== undefined && (!Number.isInteger(maxWaitMs) || maxWaitMs <= 0)) {
    // `lock_timeout` of 0 means no timeout at all, so a bound of 0 would silently be none.
    throw new RangeError(`The ${label} guard's maximum wait must be a positive integer of milliseconds`);
  }
  if (client.getTransactionStatus() !== "T") throw new Error(notInTenantTransaction);
  const { rows } = await client.query<{ isolation: string; tenant: string | null; lockTimeout: string }>(
    `SELECT current_setting('transaction_isolation') AS isolation, app_current_tenant()::text AS tenant,
            current_setting('lock_timeout') AS "lockTimeout"`,
  );
  const state = rows[0];
  if (state?.isolation !== "read committed" || state.tenant !== scope.tenantId) {
    throw new Error(notInTenantTransaction);
  }
  const key = `${namespace}:${scope.tenantId.toLowerCase()}:${id.toLowerCase()}`;
  const lock = "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))";
  if (maxWaitMs === undefined) {
    await client.query(lock, [key]);
    return;
  }
  await client.query("SELECT set_config('lock_timeout', $1, true)", [`${maxWaitMs}ms`]);
  try {
    await client.query(lock, [key]);
  } catch (error) {
    if (isLockNotAvailable(error)) throw busy();
    throw error;
  }
  await client.query("SELECT set_config('lock_timeout', $1, true)", [state.lockTimeout]);
}
