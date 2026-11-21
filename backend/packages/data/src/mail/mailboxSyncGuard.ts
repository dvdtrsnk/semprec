// The lock a sync pass's write transaction and the removal of the same mailbox both take before any
// other lock, so that neither runs while the other does.
import type { PoolClient } from "pg";
import { lockTenantAdvisoryGuard } from "../db/tenantAdvisoryGuard.js";
import { ChokePointError } from "../errors.js";

/** Below the pool's 60 s statement timeout. */
export const MAILBOX_REMOVAL_SYNC_WAIT_MS = 15_000;

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

export interface LockMailboxSyncOptions {
  /** Without it only the pool's statement timeout bounds the wait, as for a sync pass. */
  maxWaitMs?: number;
}

const MAILBOX_SYNC_GUARD = {
  label: "mailbox sync",
  namespace: "mailbox-sync:v1",
  busy: () => new MailboxSyncBusyError(),
};

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
  await lockTenantAdvisoryGuard(client, MAILBOX_SYNC_GUARD, mailboxItemId, options);
}
