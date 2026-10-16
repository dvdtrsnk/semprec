// Who may store a `stdio` MCP server config: a human in an admin's tenant.
// Constrained by: docs/adr/2026-10-16-stdio-mcp-confined-to-admin-tenants.md
import type { Queryable } from "../db/pool.js";
import { requireSingleRow } from "../db/pool.js";

/**
 * True when the current tenant (`app_tenant_default()`) has an admin user — that user specifically
 * when `userId` is given. A `userId` that is a member, or an admin of another tenant, yields false.
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
