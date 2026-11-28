import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@alldots/queue";
import { currentTenantScope } from "@alldots/shared";
import { withTransaction, type Queryable } from "../db/pool.js";
import { publishSempStatusInvalidation } from "../sempStatus/sempStatusInvalidation.js";

/** One pending job per (tenant, exhausted window): repeat enqueues for the same window collapse. */
export function aiBudgetResetJobKey(tenantId: string, resetsAt: Date): string {
  return `aiBudgetReset:${tenantId}:${resetsAt.toISOString()}`;
}

/**
 * Schedules `aiBudgetReset` for the active tenant scope at `resetsAt`. The tenant comes from the
 * scope, never an argument. The AI gateway calls this after its own transaction has rolled back.
 */
export async function enqueueAiBudgetReset(client: Queryable, resetsAt: Date): Promise<void> {
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant") throw new Error("enqueueAiBudgetReset requires a tenant scope");
  await enqueueJob(
    client,
    CORE_TASK_NAMES.AI_BUDGET_RESET,
    {},
    { runAt: resetsAt, jobKey: aiBudgetResetJobKey(scope.tenantId, resetsAt), jobKeyMode: "preserve_run_at" },
  );
}

const aiBudgetResetPayloadSchema = z.object({}).strict();

/** Announces a Semp status invalidation so clients drop the exhausted-budget problem. */
export async function handleAiBudgetResetTask(pool: Pool, payload: unknown): Promise<void> {
  aiBudgetResetPayloadSchema.parse(payload);
  await withTransaction(pool, async (client) => {
    publishSempStatusInvalidation(client);
  });
}
