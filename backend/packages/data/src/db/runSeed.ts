import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { forEachMaintainedTenant, provisionTenant } from "../tenancy/provisionTenant.js";

/**
 * The seed CLI's body (issue #644, per tenant since #1005): provisions the system databases and
 * module data migrations of every `provisioning`, `active` and `suspended` tenant, one tenant at
 * a time. The pool must connect as a role row-level security applies to (`createPool(url, { role:
 * "semprec_data" })`).
 *
 * Each outcome is `provisionTenant`'s own, decided under that tenant's advisory lock. If any tenant
 * fails the rest are still provisioned, then an `AggregateError` naming the failed tenants is thrown.
 */
export async function runSeed(
  pool: Pool,
): Promise<Array<{ tenantId: string; outcome: "created" | "already-provisioned" }>> {
  return runAsSystem("deploy seed", async () => {
    const results: Array<{ tenantId: string; outcome: "created" | "already-provisioned" }> = [];
    await forEachMaintainedTenant(pool, async (tenantId) => {
      results.push({ tenantId, outcome: await provisionTenant(pool, tenantId) });
    });
    return results;
  });
}

/** The seed CLI's output line for one tenant; it carries the tenant id only, never the connection string. */
export function formatSeedLine(result: { tenantId: string; outcome: "created" | "already-provisioned" }): string {
  return result.outcome === "created"
    ? `seed: tenant ${result.tenantId} created system databases`
    : `seed: tenant ${result.tenantId} already seeded`;
}
