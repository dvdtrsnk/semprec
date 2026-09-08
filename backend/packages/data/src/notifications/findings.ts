import type { PoolClient } from "pg";

export interface PublishFindingInput {
  kind: string;
  /** Identifies "the same finding" across runs, scoped to `kind` — e.g. the drifted id itself. */
  dedupeKey: string;
  payload: Record<string, unknown>;
}

/**
 * Inserts a `notifications` row unless an active (unresolved) finding with the same
 * `(kind, dedupeKey)` already exists — the partial unique index from migration 0011 is
 * what makes two concurrent callers reporting the same drift race safely: the loser's
 * insert is a no-op instead of a duplicate active finding.
 */
export async function publishFinding(client: PoolClient, input: PublishFindingInput): Promise<void> {
  await client.query(
    `INSERT INTO notifications (kind, dedupe_key, payload) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (kind, dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL DO NOTHING`,
    [input.kind, input.dedupeKey, JSON.stringify(input.payload)],
  );
}

/**
 * Resolves every active finding of `kind` whose `dedupeKey` is not in `stillActiveDedupeKeys` —
 * i.e. whatever the current run no longer reproduces. Naturally idempotent under concurrent
 * runs: a second caller finds zero matching rows left to update, so there is no conflict to
 * resolve.
 */
export async function resolveFindingsNotIn(
  client: PoolClient,
  kind: string,
  stillActiveDedupeKeys: ReadonlySet<string>,
): Promise<void> {
  await client.query(
    `UPDATE notifications
     SET resolved_at = now()
     WHERE kind = $1 AND resolved_at IS NULL AND dedupe_key IS NOT NULL AND NOT (dedupe_key = ANY($2::text[]))`,
    [kind, [...stillActiveDedupeKeys]],
  );
}
