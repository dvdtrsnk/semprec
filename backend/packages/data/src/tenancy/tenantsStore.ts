import type { Pool, PoolClient } from "pg";

/**
 * The id of the only tenant, via `app_sole_tenant()`. While the single-tenant guard exists a
 * missing sole tenant is an invariant violation, so it surfaces as a plain `Error` (a 500), never a domain error.
 */
export async function getSoleTenantId(client: Pool | PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string | null }>("SELECT app_sole_tenant() AS id");
  const id = rows[0]?.id;
  if (!id) throw new Error("Expected exactly one tenant, found none or several");
  return id;
}
