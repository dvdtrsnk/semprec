// The lock a sync pass's write transaction and the removal of the same mailbox both take before any
// other lock, so that neither runs while the other does.
import type { PoolClient } from "pg";
import { currentTenantScope, TenantScopeMissingError } from "@semprec/shared";
import { ChokePointError } from "../errors.js";

/** Below the pool's 60 s statement timeout. */
export const MAILBOX_REMOVAL_SYNC_WAIT_MS = 15_000;

/** `lock_not_available`, raised when `lock_timeout` ends a wait. */
const LOCK_NOT_AVAILABLE = "55P03";

const NOT_IN_TENANT_TRANSACTION = "The mailbox sync guard requires a READ COMMITTED tenant transaction";

/**
 * The database has aborted the caller's transaction, so it must roll back; the request can be repeated.
 * The holder may be a pass waiting for the mail-thread guard behind another mailbox's pass.
 */
export class MailboxSyncBusyError extends ChokePointError {
  constructor() {
    super(409, "mailbox_sync_busy", "The mailbox is being synchronized; try again shortly");
    this.name = "MailboxSyncBusyError";
  }
}

function isLockNotAvailable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === LOCK_NOT_AVAILABLE;
}

export interface LockMailboxSyncOptions {
  /** Without it only the pool's statement timeout bounds the wait, as for a sync pass. */
  maxWaitMs?: number;
}

/**
 * Held until the caller's transaction ends. The key includes the tenant, so other tenants never wait.
 * Requires a READ COMMITTED tenant transaction: otherwise the lock would not order the caller against a
 * pass that committed while it waited.
 *
 * `maxWaitMs` sets a transaction-local `lock_timeout` and restores it right after the grant so no later
 * statement inherits it. On timeout the transaction is aborted and `MailboxSyncBusyError` is thrown.
 */
export async function lockMailboxSync(
  client: PoolClient,
  mailboxItemId: string,
  options: LockMailboxSyncOptions = {},
): Promise<void> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new TenantScopeMissingError("The mailbox sync guard requires a tenant scope");
  const { maxWaitMs } = options;
  if (maxWaitMs !== undefined && (!Number.isInteger(maxWaitMs) || maxWaitMs <= 0)) {
    // `lock_timeout` of 0 means no timeout at all, so a bound of 0 would silently be none.
    throw new RangeError("The mailbox sync guard's maximum wait must be a positive integer of milliseconds");
  }
  if (client.getTransactionStatus() !== "T") throw new Error(NOT_IN_TENANT_TRANSACTION);
  const { rows } = await client.query<{ isolation: string; tenant: string | null; lockTimeout: string }>(
    `SELECT current_setting('transaction_isolation') AS isolation, app_current_tenant()::text AS tenant,
            current_setting('lock_timeout') AS "lockTimeout"`,
  );
  const state = rows[0];
  if (state?.isolation !== "read committed" || state.tenant !== scope.tenantId) {
    throw new Error(NOT_IN_TENANT_TRANSACTION);
  }
  const key = `mailbox-sync:v1:${scope.tenantId.toLowerCase()}:${mailboxItemId.toLowerCase()}`;
  const lock = "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))";
  if (maxWaitMs === undefined) {
    await client.query(lock, [key]);
    return;
  }
  await client.query("SELECT set_config('lock_timeout', $1, true)", [`${maxWaitMs}ms`]);
  try {
    await client.query(lock, [key]);
  } catch (error) {
    if (isLockNotAvailable(error)) throw new MailboxSyncBusyError();
    throw error;
  }
  await client.query("SELECT set_config('lock_timeout', $1, true)", [state.lockTimeout]);
}
