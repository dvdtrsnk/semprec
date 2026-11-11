// Owns the mailbox sync guard: the lock that a sync pass's write transaction and the removal of the
// same mailbox both take before any other lock, so that neither runs while the other does.
// Constrained by: docs/adr/2026-11-10-mailbox-removal-is-one-transaction-that-also-writes-sync-status.md
import type { PoolClient } from "pg";
import { currentTenantScope, TenantScopeMissingError } from "@semprec/shared";

/**
 * Takes the sync guard of mailbox `mailboxItemId` in the caller's transaction and holds it until that
 * transaction ends. The key names the tenant of the active scope, so a caller in another tenant that
 * passes the same id takes a different lock and never waits for this mailbox. Outside a tenant scope
 * it throws before any query.
 */
export async function lockMailboxSync(client: PoolClient, mailboxItemId: string): Promise<void> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new TenantScopeMissingError("The mailbox sync guard requires a tenant scope");
  const key = `mailbox-sync:v1:${scope.tenantId.toLowerCase()}:${mailboxItemId.toLowerCase()}`;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [key]);
}
