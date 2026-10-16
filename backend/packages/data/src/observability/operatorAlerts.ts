import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { listAdminRecipients } from "../auth/usersStore.js";
import { withTransaction } from "../db/pool.js";
import { writeNotification } from "../notifications/notify.js";
import { logger } from "./logger.js";

export interface OperatorAlertInput {
  kind: "process_stale" | "queue_backlog" | "backup_restore_failed";
  /** The transitioned `observability_checks` row. */
  checkId: string;
  /** Identifies this transition; the admin's user id is appended so each recipient has its own key. */
  transitionInstance: string;
  /** Content-free: operator alerts reach every admin, so no tenant content may be in it. */
  payload: Record<string, unknown>;
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
        withTransaction(pool, (c) =>
          writeNotification(c, {
            userId: admin.userId,
            kind: input.kind,
            linkHref: null,
            sourceTable: "observability_checks",
            sourceId: input.checkId,
            transitionInstance: `${input.transitionInstance}:${admin.userId}`,
            payload: input.payload,
          }),
        ),
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
