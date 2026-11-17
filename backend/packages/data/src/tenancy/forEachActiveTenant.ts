import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { logger } from "./logger.js";

// Process-local; only used to rotate which tenant a call starts with.
let callCounter = 0;

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Runs `work` sequentially for every active tenant in its own scope. Call `n` of this process starts at
 * index `n mod k` of the id-ordered tenants, so no tenant is always first. Failures are collected and
 * rethrown as one `AggregateError` so the job retries. Only the error class is logged: messages can carry
 * tenant content and the `tenancy` logger is not tenant-scoped; callers must not log the `errors` either.
 *
 * Runs in a system scope; called from a tenant scope it throws `TenantScopeConflictError` first.
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
        logger.error({ errorName: errorName(err), tenantId }, "Per-tenant work failed");
        errors.push(err);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `forEachActiveTenant: ${errors.length} of ${k} tenants failed`);
    }
  });
}
