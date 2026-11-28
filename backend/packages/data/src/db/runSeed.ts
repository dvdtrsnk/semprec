import type { Pool } from "pg";
import { runAsSystem } from "@alldots/shared";
import { forEachMaintainedTenant, provisionTenant } from "../tenancy/provisionTenant.js";
import { logger } from "./logger.js";

export interface SeedResult {
  tenantId: string;
  outcome: "created" | "already-provisioned";
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Provisions the system databases of every `provisioning`, `active` and `suspended` tenant, one at a
 * time, each in its own transaction; an already provisioned tenant is left as it is. The pool must connect
 * as a role row-level security applies to. A failed tenant does not stop the rest; the failures are thrown
 * together as an `AggregateError`.
 */
export async function runSeed(pool: Pool): Promise<SeedResult[]> {
  return runAsSystem("deploy seed", async () => {
    const results: SeedResult[] = [];
    const failures: Array<{ tenantId: string; error: unknown }> = [];

    await forEachMaintainedTenant(pool, async (tenantId) => {
      try {
        results.push({ tenantId, outcome: await provisionTenant(pool, tenantId) });
      } catch (error) {
        logger.error({ errorName: errorName(error), tenantId }, "Per-tenant seed work failed");
        failures.push({ tenantId, error });
      }
    });

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.error),
        `${failures.length} tenant(s) failed: ${failures.map((failure) => failure.tenantId).join(", ")}`,
      );
    }
    return results;
  });
}

/** Carries the tenant id and the outcome only, never the connection string. */
export function formatSeedLine(result: SeedResult): string {
  const prefix = `seed: tenant ${result.tenantId}`;
  return result.outcome === "created" ? `${prefix} created system databases` : `${prefix} already seeded`;
}
