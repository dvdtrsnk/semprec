import type { PoolClient } from "pg";
import { requireAffectedRows, requireSingleRow } from "../db/pool.js";

export type ObservabilityCheckStatus = "ok" | "alerting";

export interface ObservabilityCheckTransition {
  id: string;
  previousStatus: ObservabilityCheckStatus | null;
  status: ObservabilityCheckStatus;
  /** True only on an ok/missing -> alerting flip: the caller's one signal to notify. */
  transitionedToAlerting: boolean;
}

/** Closed union: the only values ever interpolated into the shared SQL below. */
type CheckTable = "observability_checks" | "tenant_observability_checks";

const CONFLICT_TARGET: Record<CheckTable, string> = {
  observability_checks: "check_key",
  tenant_observability_checks: "tenant_id, check_key",
};

type ComputeCheck = (previousStatus: ObservabilityCheckStatus | null) => {
  status: ObservabilityCheckStatus;
  detail: Record<string, unknown>;
};

/**
 * Reads the previous status `FOR UPDATE` and lets `compute` decide (where hysteresis lives).
 * `changed_at` advances only on a status flip, so "alerting since" stays meaningful.
 */
export function transitionObservabilityCheck(
  client: PoolClient,
  checkKey: string,
  compute: ComputeCheck,
): Promise<ObservabilityCheckTransition> {
  return transitionCheckIn(client, "observability_checks", checkKey, compute);
}

/** Tenant-table variant; must run in a tenant scope. */
export function transitionTenantObservabilityCheck(
  client: PoolClient,
  checkKey: string,
  compute: ComputeCheck,
): Promise<ObservabilityCheckTransition> {
  return transitionCheckIn(client, "tenant_observability_checks", checkKey, compute);
}

/**
 * A missing row is inserted before it is locked, so a concurrent run of the same check waits for this transaction and
 * then sees its status: a first transition happens once, not once per run.
 */
async function transitionCheckIn(
  client: PoolClient,
  table: CheckTable,
  checkKey: string,
  compute: ComputeCheck,
): Promise<ObservabilityCheckTransition> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO ${table} (check_key, status) VALUES ($1, 'ok')
     ON CONFLICT (${CONFLICT_TARGET[table]}) DO NOTHING
     RETURNING id`,
    [checkKey],
  );
  let id = inserted.rows[0]?.id;
  let previousStatus: ObservabilityCheckStatus | null = null;
  if (id === undefined) {
    const existing = await client.query<{ id: string; status: ObservabilityCheckStatus }>(
      `SELECT id, status FROM ${table} WHERE check_key = $1 FOR UPDATE`,
      [checkKey],
    );
    const row = requireSingleRow(existing.rows, `observability check "${checkKey}"`);
    id = row.id;
    previousStatus = row.status;
  }
  const { status, detail } = compute(previousStatus);
  const changed = previousStatus !== status;

  requireAffectedRows(
    await client.query(
      `UPDATE ${table}
       SET status = $2, detail = $3::jsonb, changed_at = CASE WHEN $4 THEN now() ELSE changed_at END
       WHERE id = $1`,
      [id, status, JSON.stringify(detail), changed],
    ),
    `observability check "${checkKey}"`,
  );

  return {
    id,
    previousStatus,
    status,
    transitionedToAlerting: changed && status === "alerting",
  };
}

/** The status of another check of the caller's tenant, `null` when it has no row; must run in a tenant scope. */
export async function getTenantObservabilityCheckStatus(
  client: PoolClient,
  checkKey: string,
): Promise<ObservabilityCheckStatus | null> {
  const { rows } = await client.query<{ status: ObservabilityCheckStatus }>(
    "SELECT status FROM tenant_observability_checks WHERE check_key = $1",
    [checkKey],
  );
  return rows[0]?.status ?? null;
}

/**
 * Rows whose source is gone would never be re-evaluated and could sit `alerting` forever. RLS limits it to the
 * caller's tenant.
 */
export function deleteOrphanedTenantObservabilityChecks(
  client: PoolClient,
  checkKeyPrefix: string,
  currentCheckKeys: readonly string[],
): Promise<number> {
  return deleteOrphansIn(client, "tenant_observability_checks", checkKeyPrefix, currentCheckKeys);
}

async function deleteOrphansIn(
  client: PoolClient,
  table: CheckTable,
  checkKeyPrefix: string,
  currentCheckKeys: readonly string[],
): Promise<number> {
  const result = await client.query(
    `DELETE FROM ${table} WHERE check_key LIKE $1 AND NOT (check_key = ANY($2::text[]))`,
    [`${checkKeyPrefix}%`, currentCheckKeys],
  );
  return result.rowCount ?? 0;
}
