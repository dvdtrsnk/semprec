import type { PoolClient } from "pg";
import type { ObservabilityCheckStatus } from "./observabilityChecksStore.js";

/** The status of another check of the caller's tenant, `null` when it has no row; must run in a tenant scope. */
export async function getTenantObservabilityCheckStatus(
  client: PoolClient,
  checkKey: string,
): Promise<ObservabilityCheckStatus | null> {
  const { rows } = await client.query<{ status: ObservabilityCheckStatus }>(
    "SELECT status FROM tenant_observability_checks WHERE check_key = $1",
    [checkKey],
  );
  return rows[0]?.status ?? null;
}
