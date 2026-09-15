import type { PoolClient } from "pg";

export type ObservabilityCheckStatus = "ok" | "alerting";

export interface ObservabilityCheckTransition {
  id: string;
  previousStatus: ObservabilityCheckStatus | null;
  status: ObservabilityCheckStatus;
  /** True only on a genuine ok/missing -> alerting flip — the caller's one signal to notify. */
  transitionedToAlerting: boolean;
  /** True only on a genuine alerting -> ok flip — the caller's one signal to "rearm" a later alert. */
  transitionedToOk: boolean;
}

/**
 * Reads `check_key`'s current status under `FOR UPDATE` (serializing concurrent callers of the
 * same check, though `observability.checkSystem` only ever runs one tick at a time), lets
 * `compute` decide the new status/detail from that previous status — this is where a caller
 * implements hysteresis, e.g. the queue-backlog check entering `alerting` at a higher threshold
 * than it requires to recover back to `ok` — then upserts. `changed_at` only advances on an
 * actual status flip, never on a same-status detail refresh, so "how long has this been alerting"
 * stays meaningful across many ticks that all reconfirm the same fault.
 */
export async function transitionObservabilityCheck(
  client: PoolClient,
  checkKey: string,
  compute: (previousStatus: ObservabilityCheckStatus | null) => {
    status: ObservabilityCheckStatus;
    detail: Record<string, unknown>;
  },
): Promise<ObservabilityCheckTransition> {
  const existing = await client.query<{ status: ObservabilityCheckStatus }>(
    `SELECT status FROM observability_checks WHERE check_key = $1 FOR UPDATE`,
    [checkKey],
  );
  const previousStatus = existing.rows[0]?.status ?? null;
  const { status, detail } = compute(previousStatus);
  const changed = previousStatus !== status;

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO observability_checks (check_key, status, detail, changed_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (check_key) DO UPDATE SET
       status = excluded.status,
       detail = excluded.detail,
       changed_at = CASE WHEN $4 THEN now() ELSE observability_checks.changed_at END
     RETURNING id`,
    [checkKey, status, JSON.stringify(detail), changed],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`transitionObservabilityCheck: upsert for "${checkKey}" returned no row`);

  return {
    id,
    previousStatus,
    status,
    transitionedToAlerting: changed && status === "alerting",
    transitionedToOk: changed && status === "ok",
  };
}
