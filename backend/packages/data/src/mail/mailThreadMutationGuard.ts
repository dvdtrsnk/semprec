import type { PoolClient } from "pg";
import { currentTenantScope, TenantScopeMissingError } from "@semprec/shared";

/** Acquires the tenant's mail-thread mutation guard in the caller's READ COMMITTED transaction. */
export async function lockMailThreadMutation(client: PoolClient): Promise<void> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new TenantScopeMissingError("Mail thread mutation requires a tenant scope");
  if (client.getTransactionStatus() !== "T")
    throw new Error("Mail thread mutation requires a READ COMMITTED tenant transaction");
  const { rows } = await client.query<{ isolation: string; tenant: string | null }>(
    "SELECT current_setting('transaction_isolation') AS isolation, app_current_tenant()::text AS tenant",
  );
  const state = rows[0];
  if (state?.isolation !== "read committed" || state.tenant !== scope.tenantId) {
    throw new Error("Mail thread mutation requires a READ COMMITTED tenant transaction");
  }
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
    `mail-thread-mutation:v1:${scope.tenantId.toLowerCase()}`,
  ]);
}
