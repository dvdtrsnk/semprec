import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { currentTenantScope } from "@semprec/shared";
import { withTransaction, type Queryable } from "../db/pool.js";
import { publishSempStatusInvalidation } from "../sempStatus/sempStatusInvalidation.js";

/**
 * The one pending `aiBudgetReset` job of a tenant's exhausted window: the tenant and the instant the
 * window resets, rendered as `Date.prototype.toISOString` renders it. Two enqueues for the same window
 * therefore name the same job, and another tenant's window never does.
 */
export function aiBudgetResetJobKey(tenantId: string, resetsAt: Date): string {
  return `aiBudgetReset:${tenantId}:${resetsAt.toISOString()}`;
}

/**
 * Schedules `aiBudgetReset` for the current tenant at `resetsAt`, the instant its exhausted AI budget
 * window resets (issue gh-2024). The tenant is the one of the active scope, never an argument, and it is
 * stamped into the job's envelope by `enqueueJob`; a system or missing scope is refused before any query.
 * The job key makes a second enqueue for the same window a repeat of the first (`preserve_run_at` keeps
 * the queued run time). The enqueue is a single statement on `client`, so it is part of the transaction of
 * `client` when that is one; the AI gateway calls it after its own transaction has rolled back.
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

/**
 * `aiBudgetReset`: runs in the job envelope's tenant and announces one Semp status invalidation, so a
 * connected client drops the exhausted-budget problem that the next status read no longer lists. It reads
 * and writes no budget data; the payload carries nothing.
 */
export async function handleAiBudgetResetTask(pool: Pool, payload: unknown): Promise<void> {
  aiBudgetResetPayloadSchema.parse(payload);
  await withTransaction(pool, async (client) => {
    publishSempStatusInvalidation(client);
  });
}
