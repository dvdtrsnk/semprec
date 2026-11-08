import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createComputedKeyRegistry } from "../chokePoint/computedKeyRegistry.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { requireAffectedRows, withTransaction, type Queryable } from "../db/pool.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { runModuleDataMigrations } from "../migrationJob/moduleDataMigration.js";
import { seedSystem } from "../seed/seedSystem.js";
import { logger } from "./logger.js";

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Throws unless row-level security applies to the connection's role. Provisioning reads "is this
 * tenant already seeded?" and writes its rows; as a superuser or table owner RLS is bypassed and
 * those reads would see every tenant.
 */
export async function assertRowSecurityActive(queryable: Queryable): Promise<void> {
  const { rows } = await queryable.query<{ active: boolean }>(
    "SELECT row_security_active('public.databases') AS active",
  );
  if (rows[0]?.active !== true) {
    throw new Error(
      "Tenant provisioning must run as a role row-level security applies to (for example semprec_data), not as a superuser or table owner",
    );
  }
}

/**
 * Creates one tenant's system databases and activates the tenant: seeds the system databases,
 * runs every module's data migrations, then moves a `provisioning` tenant to `active`. A
 * `suspended` tenant is seeded and stays suspended; a `deleting` or unknown tenant rejects.
 * Everything runs inside the tenant's scope, and the pool must connect as a role RLS applies to.
 *
 * Resolves `"created"` exactly when this call wrote the structural seed, so of two concurrent
 * calls for one tenant exactly one reports it.
 */
export async function provisionTenant(pool: Pool, tenantId: string): Promise<"created" | "already-provisioned"> {
  return runInTenant(tenantId, async () => {
    await assertRowSecurityActive(pool);
    const seeded = await seedSystem(pool, createViewTypeRegistry(), createComputedKeyRegistry());
    await runModuleDataMigrations(pool, await loadFullModuleRegistry());
    await withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ status: string }>("SELECT status FROM tenants WHERE id = $1 FOR UPDATE", [
        tenantId,
      ]);
      const status = rows[0]?.status;
      if (status === "provisioning") {
        const result = await client.query(
          "UPDATE tenants SET status = 'active', status_changed_at = now() WHERE id = $1",
          [tenantId],
        );
        requireAffectedRows(result, "activating the provisioned tenant");
      } else if (status !== "active" && status !== "suspended") {
        throw new Error(`provisionTenant: tenant ${tenantId} is ${status ?? "missing"}`);
      }
    });
    return seeded === "created" ? "created" : "already-provisioned";
  });
}

/**
 * Runs `fn` once for every tenant a deploy must keep current — `provisioning` (to finish it),
 * `active` and `suspended` (to keep its data shape current), never `deleting` — each inside that
 * tenant's scope, one after another. A failing tenant does not stop the others; afterwards one
 * `AggregateError` naming the failed tenant ids is thrown.
 */
export async function forEachMaintainedTenant(pool: Pool, fn: (tenantId: string) => Promise<void>): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM tenants WHERE status IN ('provisioning','active','suspended') ORDER BY created_at, id",
  );
  const failed: string[] = [];
  const errors: unknown[] = [];
  for (const { id } of rows) {
    try {
      await runInTenant(id, () => fn(id));
    } catch (err) {
      logger.error({ errorName: errorName(err), tenantId: id }, "Per-tenant deploy work failed");
      failed.push(id);
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} of ${rows.length} tenants failed: ${failed.join(", ")}`);
  }
}
