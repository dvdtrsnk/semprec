import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { readSeedDefinitions, reconcileSeedDefinitions, type SeedReconcileReport } from "../seed/seedReconcile.js";
import { forEachMaintainedTenant, provisionTenant } from "../tenancy/provisionTenant.js";
import { logger } from "./logger.js";

export interface SeedResult {
  tenantId: string;
  outcome: "created" | "already-provisioned";
  /** Set for an already provisioned tenant: what the reconcile added and which definitions differ. */
  reconcile: SeedReconcileReport | null;
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Provisions the system databases of every `provisioning`, `active` and `suspended` tenant, one at a
 * time, then reconciles every tenant that was already provisioned with the current seed's definitions
 * (`reconcileSeedDefinitions`), each in its own transaction. The pool must connect as a role row-level
 * security applies to. A failed tenant does not stop the rest; the failures of both passes are thrown
 * together as an `AggregateError`.
 */
export async function runSeed(pool: Pool): Promise<SeedResult[]> {
  return runAsSystem("deploy seed", async () => {
    const results: SeedResult[] = [];
    const failures: Array<{ tenantId: string; error: unknown }> = [];
    const isolate = async (tenantId: string, work: () => Promise<void>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        logger.error({ errorName: errorName(error), tenantId }, "Per-tenant seed work failed");
        failures.push({ tenantId, error });
      }
    };

    await forEachMaintainedTenant(pool, (tenantId) =>
      isolate(tenantId, async () => {
        results.push({ tenantId, outcome: await provisionTenant(pool, tenantId), reconcile: null });
      }),
    );

    const seeded = results.filter((result) => result.outcome === "already-provisioned");
    if (seeded.length > 0) {
      const reference = await readSeedDefinitions(pool);
      for (const result of seeded) {
        await isolate(result.tenantId, async () => {
          result.reconcile = await runInTenant(result.tenantId, () => reconcileSeedDefinitions(pool, reference));
        });
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.error),
        `${failures.length} tenant(s) failed: ${failures.map((failure) => failure.tenantId).join(", ")}`,
      );
    }
    return results;
  });
}

/** Carries the tenant id, counts, fixed tags and seed-defined keys only, never the connection string. */
export function formatSeedLines(result: SeedResult): string[] {
  const prefix = `seed: tenant ${result.tenantId}`;
  if (result.outcome === "created") return [`${prefix} created system databases`];
  const lines = [`${prefix} already seeded`];
  if (result.reconcile) {
    const { createdProperties, createdRelationDefinitions, appendedOptions, conflicts } = result.reconcile;
    const optionCount = appendedOptions.reduce((sum, appended) => sum + appended.options.length, 0);
    lines.push(
      `${prefix} reconcile created ${createdProperties} properties, ${createdRelationDefinitions} relation definitions, appended ${optionCount} select options`,
    );
    for (const appended of appendedOptions) {
      lines.push(`${prefix} appended options ${appended.database}.${appended.key} ${appended.options.join(",")}`);
    }
    for (const conflict of conflicts) {
      lines.push(
        `${prefix} conflict ${conflict.tag} ${conflict.database}${conflict.key === null ? "" : `.${conflict.key}`}`,
      );
    }
  }
  return lines;
}

/** With `strict`, any conflicting definition fails the run; otherwise conflicts are only reported. */
export function seedExitCode(results: readonly SeedResult[], strict: boolean): 0 | 1 {
  return strict && results.some((result) => (result.reconcile?.conflicts.length ?? 0) > 0) ? 1 : 0;
}
