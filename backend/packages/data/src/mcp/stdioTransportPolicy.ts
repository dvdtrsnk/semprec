// Who may store a `stdio` MCP server config: a human admin of the current tenant.
import type { Queryable } from "../db/pool.js";
import { requireSingleRow } from "../db/pool.js";

/**
 * With `userId`, true only when that user is an admin of the current tenant. Write hooks must pass the writer, or
 * any writer in a tenant with an admin would pass. The spawn check omits it on purpose: it asks whether the tenant
 * allows `stdio` at all.
 */
export async function tenantAllowsStdio(client: Queryable, userId?: string): Promise<boolean> {
  const result = await client.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM users
       WHERE role = 'admin' AND tenant_id = app_tenant_default() AND ($1::uuid IS NULL OR id = $1)
     ) AS allowed`,
    [userId ?? null],
  );
  return requireSingleRow(result.rows, "tenantAllowsStdio").allowed;
}
