import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { listAdminRecipients } from "../auth/usersStore.js";
import { withTransaction } from "../db/pool.js";
import { writeNotification } from "../notifications/notify.js";
import { raiseProblem, resolveProblem } from "../semp/sempProblemsStore.js";
import { logger } from "./logger.js";

export interface OperatorAlertInput {
  kind: "process_stale" | "queue_backlog" | "backup_restore_failed";
  /** The transitioned `observability_checks` row. */
  checkId: string;
  /** Identifies this transition; the admin's user id is appended so each recipient has its own key. */
  transitionInstance: string;
  /** Content-free: operator alerts reach every admin, so no tenant content may be in it. */
  payload: Record<string, unknown>;
  /**
   * The Semp status problem to raise for each admin, in the same per-recipient transaction as the
   * notification (issue #1465). Omit it for an alert that raises none (`queue_backlog`).
   */
  problem?: {
    kind: string;
    category: "agents" | "backup";
    severity: "critical" | "warning";
    dedupeKey: string;
    /** Identifies this transition; the admin's user id is appended like the notification's. */
    occurrenceKey: string;
  };
}

/**
 * Writes one content-free operator notification to every admin of an active tenant and returns
 * the notification ids (`[]` with no admin).
 *
 * `client` is the caller's open system-scope transaction and only reads the recipients. Each
 * admin's row is written sequentially in its own transaction opened inside that admin's tenant
 * (`notifications` is row-level secured), and commits before the caller's transaction does — so
 * at most two connections are held at once.
 *
 * One admin's failed write does not skip the others: it is logged and collected, and after the
 * loop any failure is rethrown as an `AggregateError`, which rolls back the caller's transition so
 * the job's retry redelivers. The retry reuses the same job id, hence the same per-recipient
 * `transitionInstance`, and `writeNotification` deduplicates the admins already written. Delivery
 * is therefore at least once, with exactly one row per admin and transition across retries of the
 * same job (or, for a restore run, re-records of the same run id).
 *
 * That bound does not extend past the job: while a failure persists, every later attempt with a new
 * `transitionInstance` — the next crontab tick of `observability.checkSystem` under a new job id — sees
 * the same not-yet-recorded transition and re-alerts the admins already written. So does a retry of a
 * check's first-ever transition, whose rolled-back check row comes back with a new id (the
 * notification's `sourceId`). The rollback-driven retry is the contract issue #1019 chose over
 * committing the transition apart from its delivery.
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
 * Resolves, as recovered, the Semp status problem `dedupeKey` of every admin of an active tenant (issue
 * #1915), the counterpart of the `problem` that `writeOperatorAlert` raised for each of them. `client` is
 * the caller's open system-scope transaction and only reads the recipients; each admin's problem is
 * resolved in its own transaction opened inside that admin's tenant, which commits before the caller's.
 * An admin with no active problem under the key changes nothing.
 *
 * Like `writeOperatorAlert`, one admin's failure does not skip the others: it is logged and, after the
 * loop, rethrown as an `AggregateError`, which rolls back the caller's transition back to `ok` so the next
 * attempt resolves again (resolving is idempotent).
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
