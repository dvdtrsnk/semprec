import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { listAdminRecipients } from "../auth/usersStore.js";
import { withTransaction } from "../db/pool.js";
import { writeNotification } from "../notifications/notify.js";
import { raiseProblem, resolveProblem } from "../semp/sempProblemsStore.js";
import { logger } from "./logger.js";

export interface OperatorAlertInput {
  kind: "process_stale" | "queue_backlog" | "backup_restore_failed";
  checkId: string;
  /** The admin's user id is appended so each recipient has its own key. */
  transitionInstance: string;
  /** Content-free: operator alerts reach every admin, so no tenant content may be in it. */
  payload: Record<string, unknown>;
  /** Raised in the same per-recipient transaction as the notification. */
  problem?: {
    kind: string;
    category: "agents" | "backup";
    severity: "critical" | "warning";
    dedupeKey: string;
    /** The admin's user id is appended, like the notification's. */
    occurrenceKey: string;
  };
}

/**
 * `client` (system scope) only reads recipients; each admin is written sequentially in its own
 * tenant-scoped transaction (RLS), so at most two connections are held.
 *
 * A failed admin does not skip the others; failures are rethrown as an `AggregateError`, rolling
 * back the caller's transition so the job retries. Retries reuse the job id, so
 * `writeNotification` dedupes admins already written. A later tick under a new job id (or a
 * re-created first-ever check row) re-alerts them: at-least-once is the deliberate trade-off for
 * never committing a transition apart from its delivery.
 */
export async function writeOperatorAlert(pool: Pool, client: PoolClient, input: OperatorAlertInput): Promise<string[]> {
  const admins = await listAdminRecipients(client);
  const ids: string[] = [];
  const errors: unknown[] = [];
  for (const admin of admins) {
    try {
      const id = await runInTenant(admin.tenantId, () =>
        withTransaction(pool, async (c) => {
          const notificationId = await writeNotification(c, {
            userId: admin.userId,
            kind: input.kind,
            linkHref: null,
            sourceTable: "observability_checks",
            sourceId: input.checkId,
            transitionInstance: `${input.transitionInstance}:${admin.userId}`,
            payload: input.payload,
          });
          if (input.problem) {
            await raiseProblem(c, {
              userId: admin.userId,
              category: input.problem.category,
              kind: input.problem.kind,
              severity: input.problem.severity,
              sourceTable: "observability_checks",
              sourceId: input.checkId,
              dedupeKey: input.problem.dedupeKey,
              occurrenceKey: `${input.problem.occurrenceKey}:${admin.userId}`,
            });
          }
          return notificationId;
        }),
      );
      ids.push(id);
    } catch (err) {
      logger.error({ err, tenantId: admin.tenantId }, "Operator alert write failed for one admin");
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `writeOperatorAlert: ${errors.length} of ${admins.length} admins failed`);
  }
  return ids;
}

/**
 * Counterpart of `writeOperatorAlert`'s `problem`, with the same per-admin transactions and
 * `AggregateError` rollback; resolving is idempotent, so the next attempt simply resolves again.
 */
export async function resolveOperatorAlertProblems(pool: Pool, client: PoolClient, dedupeKey: string): Promise<void> {
  const admins = await listAdminRecipients(client);
  const errors: unknown[] = [];
  for (const admin of admins) {
    try {
      await runInTenant(admin.tenantId, () =>
        withTransaction(pool, (c) => resolveProblem(c, { dedupeKey, resolutionKind: "recovered" })),
      );
    } catch (err) {
      logger.error({ err, tenantId: admin.tenantId }, "Operator alert problem resolution failed for one admin");
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `resolveOperatorAlertProblems: ${errors.length} of ${admins.length} admins failed`,
    );
  }
}
