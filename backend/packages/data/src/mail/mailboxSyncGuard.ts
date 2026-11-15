// Owns the mailbox sync guard: the lock that a sync pass's write transaction and the removal of the
// same mailbox both take before any other lock, so that neither runs while the other does.
// Constrained by: docs/adr/2026-11-10-mailbox-removal-is-one-transaction-that-also-writes-sync-status.md,
// docs/adr/2026-11-15-a-mailbox-removal-waits-a-bounded-time-for-the-sync-guard-and-answers-busy.md
import type { PoolClient } from "pg";
import { currentTenantScope, TenantScopeMissingError } from "@semprec/shared";
import { ChokePointError } from "../errors.js";

/** How long a mailbox removal waits for the sync guard before it answers `mailbox_sync_busy`; below the pool's 60 s statement timeout. */
export const MAILBOX_REMOVAL_SYNC_WAIT_MS = 15_000;

/** SQLSTATE 55P03 (`lock_not_available`), what Postgres raises when `lock_timeout` ends a wait for a lock. */
const LOCK_NOT_AVAILABLE = "55P03";

const NOT_IN_TENANT_TRANSACTION = "The mailbox sync guard requires a READ COMMITTED tenant transaction";

/**
 * The sync guard of a mailbox was still held when the bounded wait of `lockMailboxSync` ended. The
 * database aborts the caller's transaction at that point, so the caller's transaction ends by rollback
 * with nothing written, and the request can be repeated. It does not say that this mailbox is being
 * synchronized: the holder can be a pass of this mailbox that waits for the tenant's mail-thread
 * mutation guard behind a pass of another mailbox.
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
  /**
   * The longest the lock statement may wait, in milliseconds, a positive integer. Without it the wait is
   * unbounded except by the pool's statement timeout, which is what a sync pass uses.
   */
  maxWaitMs?: number;
}

/**
 * Takes the sync guard of mailbox `mailboxItemId` in the caller's transaction and holds it until that
 * transaction ends. The key names the tenant of the active scope, so a caller in another tenant that
 * passes the same id takes a different lock and never waits for this mailbox.
 *
 * Before it locks it requires a tenant scope (`TenantScopeMissingError` otherwise) and a client that is
 * inside a READ COMMITTED transaction of that tenant, and throws an `Error` otherwise. A lock taken
 * outside a transaction, or at another isolation level, would not order the caller against a sync pass
 * that committed while it waited.
 *
 * With `maxWaitMs` the lock statement runs under a `lock_timeout` of that length, set for this
 * transaction only, and the previous value is set back in the next statement once the lock is granted,
 * so no later statement of the transaction inherits the bound. When the bound ends the wait the
 * database aborts the transaction (SQLSTATE 55P03), so there is nothing to put back: the function throws
 * `MailboxSyncBusyError`, and the caller's transaction must end by rollback.
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
