import type { PoolClient } from "pg";

export type ObservabilityCheckStatus = "ok" | "alerting";

export interface ObservabilityCheckTransition {
  id: string;
  previousStatus: ObservabilityCheckStatus | null;
  status: ObservabilityCheckStatus;
  /** True only on a genuine ok/missing -> alerting flip — the caller's one signal to notify. */
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
 * Reads `check_key`'s current status under `FOR UPDATE` (serializing concurrent callers of the
 * same check, though `observability.checkSystem` only ever runs one tick at a time), lets
 * `compute` decide the new status/detail from that previous status — this is where a caller
 * implements hysteresis, e.g. the queue-backlog check entering `alerting` at a higher threshold
 * than it requires to recover back to `ok` — then upserts. `changed_at` only advances on an
 * actual status flip, never on a same-status detail refresh, so "how long has this been alerting"
 * stays meaningful across many ticks that all reconfirm the same fault.
 */
export function transitionObservabilityCheck(
  client: PoolClient,
  checkKey: string,
  compute: ComputeCheck,
): Promise<ObservabilityCheckTransition> {
  return transitionCheckIn(client, "observability_checks", checkKey, compute);
}

/** `transitionObservabilityCheck` on the tenant table; the tenant comes from RLS and the column default, so it must run in a tenant scope. */
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
 * Drops `observability_checks` rows whose `check_key` starts with `checkKeyPrefix` but is not in
 * `currentCheckKeys` — the check's own source (e.g. a deleted mail account) is gone, so the row
 * would otherwise never be re-evaluated and would sit `alerting` forever with no path back to `ok`.
 */
export function deleteOrphanedObservabilityChecks(
  client: PoolClient,
  checkKeyPrefix: string,
  currentCheckKeys: readonly string[],
): Promise<number> {
  return deleteOrphansIn(client, "observability_checks", checkKeyPrefix, currentCheckKeys);
}

/** `deleteOrphanedObservabilityChecks` on the tenant table; RLS limits it to the caller's tenant's rows. */
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
  // Zero is the common case (no orphans this tick) — there is nothing to act on beyond returning
  // the count, which exists so a caller could log or assert on it if it ever needed to.
  return result.rowCount ?? 0;
}
