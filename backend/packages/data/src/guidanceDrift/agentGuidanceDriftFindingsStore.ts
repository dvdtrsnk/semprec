import type { PoolClient } from "pg";
import type {
  GuidanceDriftFinding,
  GuidanceDriftFindingStore,
  UpsertActiveGuidanceDriftFindingInput,
} from "@semprec/shared";
import { validateGuidanceDriftContradiction } from "@semprec/shared";
import { requireSingleRow } from "../db/pool.js";
import { NotFoundError } from "../errors.js";

interface FindingRow {
  id: string;
  project_item_id: string;
  fingerprint: string;
  // JSONB column: the `pg` driver hands back a plain object with no runtime guarantee it still
  // matches `GuidanceDriftContradiction`'s shape (a direct DB patch or schema evolution could
  // diverge it), so `mapRow` validates and narrows it below rather than casting.
  payload: Record<string, unknown>;
  status: "active" | "resolved";
  first_seen_at: Date;
  last_seen_at: Date;
  resolved_at: Date | null;
}

function mapRow(row: FindingRow): GuidanceDriftFinding {
  return {
    id: row.id,
    projectItemId: row.project_item_id,
    fingerprint: row.fingerprint,
    payload: validateGuidanceDriftContradiction(row.payload, `agent_guidance_drift_findings row ${row.id}`),
    status: row.status,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
  };
}

const COLUMNS = "id, project_item_id, fingerprint, payload, status, first_seen_at, last_seen_at, resolved_at";

/**
 * Concrete `PoolClient` implementation of `@semprec/shared`'s `GuidanceDriftFindingStore`
 * (issue #85), backed by migration 0035's `agent_guidance_drift_findings` table and its
 * `unique(project_item_id, fingerprint)` constraint.
 */
export const agentGuidanceDriftFindingsStore: GuidanceDriftFindingStore<PoolClient> = {
  async listActive(tx, projectItemId) {
    const { rows } = await tx.query<FindingRow>(
      `SELECT ${COLUMNS} FROM agent_guidance_drift_findings WHERE project_item_id = $1 AND status = 'active'`,
      [projectItemId],
    );
    return rows.map(mapRow);
  },

  async upsertActive(tx, input: UpsertActiveGuidanceDriftFindingInput) {
    // Row-lock first (rather than a single `INSERT ... ON CONFLICT`) because the caller needs to
    // know whether this was a genuine active/resolved *transition* — an `ON CONFLICT DO UPDATE`
    // can't distinguish "was already active" from "was resolved" for the row it just touched.
    const { rows: existingRows } = await tx.query<{ id: string; status: "active" | "resolved" }>(
      `SELECT id, status FROM agent_guidance_drift_findings
       WHERE project_item_id = $1 AND fingerprint = $2 FOR UPDATE`,
      [input.projectItemId, input.fingerprint],
    );
    const existing = existingRows[0];
    const payloadJson = JSON.stringify(input.payload);

    if (!existing) {
      const { rows } = await tx.query<FindingRow>(
        `INSERT INTO agent_guidance_drift_findings
           (project_item_id, fingerprint, payload, status, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3::jsonb, 'active', $4, $4)
         RETURNING ${COLUMNS}`,
        [input.projectItemId, input.fingerprint, payloadJson, input.seenAt],
      );
      return {
        finding: mapRow(requireSingleRow(rows, "agent_guidance_drift_findings insert")),
        transitionedToActive: true,
      };
    }

    const wasResolved = existing.status === "resolved";
    const { rows } = await tx.query<FindingRow>(
      `UPDATE agent_guidance_drift_findings
       SET status = 'active', last_seen_at = $2, resolved_at = NULL, payload = $3::jsonb
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [existing.id, input.seenAt, payloadJson],
    );
    return {
      finding: mapRow(requireSingleRow(rows, "agent_guidance_drift_findings reactivate/observe")),
      transitionedToActive: wasResolved,
    };
  },

  async resolve(tx, findingId, resolvedAt) {
    const { rows: existingRows } = await tx.query<{ status: "active" | "resolved" }>(
      `SELECT status FROM agent_guidance_drift_findings WHERE id = $1 FOR UPDATE`,
      [findingId],
    );
    const existing = existingRows[0];
    if (!existing) throw new NotFoundError(`Guidance drift finding ${findingId} not found`);

    const wasActive = existing.status === "active";
    const { rows } = await tx.query<FindingRow>(
      `UPDATE agent_guidance_drift_findings
       SET status = 'resolved', resolved_at = $2, last_seen_at = $2
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [findingId, resolvedAt],
    );
    return {
      finding: mapRow(requireSingleRow(rows, "agent_guidance_drift_findings resolve")),
      transitionedToResolved: wasActive,
    };
  },
};
