import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { forEachMaintainedTenant, provisionTenant } from "../tenancy/provisionTenant.js";

/**
 * Provisions the system databases of every `provisioning`, `active` and `suspended` tenant, one at a
 * time. The pool must connect as a role row-level security applies to. A failed tenant does not stop
 * the rest; the failures are thrown together as an `AggregateError`.
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

/** Carries the tenant id only, never the connection string. */
export function formatSeedLine(result: { tenantId: string; outcome: "created" | "already-provisioned" }): string {
  return result.outcome === "created"
    ? `seed: tenant ${result.tenantId} created system databases`
    : `seed: tenant ${result.tenantId} already seeded`;
}
