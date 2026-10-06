import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { logger } from "./logger.js";

// Process-local; only used to rotate which tenant a call starts with.
let callCounter = 0;

/**
 * Runs `work` once for every active tenant, each inside that tenant's own scope, sequentially.
 * Call number `n` of this process starts at index `n mod k` of the id-ordered tenants and wraps
 * around, so no tenant is always first. A tenant whose `work` throws is logged and collected and the
 * loop continues; afterwards the original errors are rethrown as one `AggregateError` so the calling
 * job fails and is retried. Suspended, provisioning and deleting tenants are skipped.
 *
 * Runs in a system scope, so it may be called with no scope or from a system scope; called from a
 * tenant scope it throws `TenantScopeConflictError` before doing anything.
 * See `docs/adr/2026-10-06-system-work-fans-out-per-tenant.md`.
 */
export async function forEachActiveTenant(pool: Pool, work: (tenantId: string) => Promise<void>): Promise<void> {
  return runAsSystem("tenant-fan-out", async () => {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM tenants WHERE status = 'active' ORDER BY id");
    const k = rows.length;
    if (k === 0) return;

    const start = callCounter % k;
    callCounter += 1;

    const errors: unknown[] = [];
    for (let offset = 0; offset < k; offset += 1) {
      const row = rows[(start + offset) % k];
      if (!row) continue;
      const tenantId = row.id;
      try {
        await runInTenant(tenantId, () => work(tenantId));
      } catch (err) {
        logger.error({ err, tenantId }, "Per-tenant work failed");
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `forEachActiveTenant: ${errors.length} of ${k} tenants failed`);
    }
  });
}
