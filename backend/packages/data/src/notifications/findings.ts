import type { PoolClient } from "pg";

export interface PublishFindingInput {
  kind: string;
  /** Identifies the same finding across runs within `kind`, e.g. the drifted id. */
  dedupeKey: string;
  payload: Record<string, unknown>;
}

/**
 * Per-tenant dedupe of active findings. The partial unique index
 * `manifest_drift_findings_tenant_active_idx` arbitrates, so concurrent reporters cannot duplicate.
 */
export async function publishFinding(client: PoolClient, input: PublishFindingInput): Promise<void> {
  await client.query(
    `INSERT INTO manifest_drift_findings (kind, dedupe_key, payload) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (tenant_id, kind, dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL DO NOTHING`,
    [input.kind, input.dedupeKey, JSON.stringify(input.payload)],
  );
}

/** Resolves what the current run no longer reproduces. Idempotent; RLS confines it to the tenant. */
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
