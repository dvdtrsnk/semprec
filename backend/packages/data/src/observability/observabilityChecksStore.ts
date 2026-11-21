import type { PoolClient } from "pg";

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

async function transitionCheckIn(
  client: PoolClient,
  table: CheckTable,
  checkKey: string,
  compute: ComputeCheck,
): Promise<ObservabilityCheckTransition> {
  const existing = await client.query<{ status: ObservabilityCheckStatus }>(
    `SELECT status FROM ${table} WHERE check_key = $1 FOR UPDATE`,
    [checkKey],
  );
  const previousStatus = existing.rows[0]?.status ?? null;
  const { status, detail } = compute(previousStatus);
  const changed = previousStatus !== status;

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ${table} (check_key, status, detail, changed_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (${CONFLICT_TARGET[table]}) DO UPDATE SET
       status = excluded.status,
       detail = excluded.detail,
       changed_at = CASE WHEN $4 THEN now() ELSE ${table}.changed_at END
     RETURNING id`,
    [checkKey, status, JSON.stringify(detail), changed],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`transitionCheckIn: upsert for "${checkKey}" returned no row`);

  return {
    id,
    previousStatus,
    status,
    transitionedToAlerting: changed && status === "alerting",
  };
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
