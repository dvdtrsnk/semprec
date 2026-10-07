import type { PoolClient } from "pg";

export interface PublishFindingInput {
  kind: string;
  /** Identifies "the same finding" across runs, scoped to `kind` — e.g. the drifted id itself. */
  dedupeKey: string;
  payload: Record<string, unknown>;
}

/**
 * Inserts a `manifest_drift_findings` row unless an active (unresolved) finding with the same
 * `(kind, dedupeKey)` already exists in the current tenant — the dedupe is per tenant, and the
 * `tenant_id` column default fills the tenant from the scope. The partial unique index
 * `manifest_drift_findings_tenant_active_idx` (migration 0064) is the conflict arbiter and what
 * makes two concurrent callers reporting the same drift race safely: the loser's insert is a
 * no-op instead of a duplicate active finding. While the legacy global
 * `manifest_drift_findings_active_idx` (migration 0030) still exists, a second tenant reporting
 * a key another tenant has active collides with it only and raises `unique_violation` (`23505`)
 * rather than silently doing nothing.
 */
export async function publishFinding(client: PoolClient, input: PublishFindingInput): Promise<void> {
  await client.query(
    `INSERT INTO manifest_drift_findings (kind, dedupe_key, payload) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (tenant_id, kind, dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL DO NOTHING`,
    [input.kind, input.dedupeKey, JSON.stringify(input.payload)],
  );
}

/**
 * Resolves every active finding of `kind` whose `dedupeKey` is not in `stillActiveDedupeKeys` —
 * i.e. whatever the current run no longer reproduces. Naturally idempotent under concurrent
 * runs: a second caller finds zero matching rows left to update, so there is no conflict to
 * resolve. Row-level security confines the update to the current tenant's findings, so another
 * tenant's active findings of the same kind are never resolved.
 */
export async function resolveFindingsNotIn(
  client: PoolClient,
  kind: string,
  stillActiveDedupeKeys: ReadonlySet<string>,
): Promise<void> {
  await client.query(
    `UPDATE manifest_drift_findings
     SET resolved_at = now()
     WHERE kind = $1 AND resolved_at IS NULL AND dedupe_key IS NOT NULL AND NOT (dedupe_key = ANY($2::text[]))`,
    [kind, [...stillActiveDedupeKeys]],
  );
}
