import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { GuidanceReferenceNotFoundError, type GuidanceDriftFinding } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { guidanceReferenceStore, projectAgentGuidanceStore } from "../projectAgentGuidanceStore.js";
import { agentGuidanceDriftFindingsStore } from "./agentGuidanceDriftFindingsStore.js";
import { resolveGuidanceDriftFinding } from "./resolveGuidanceDriftFinding.js";
import { loadGuidanceSections } from "../projectAgentGuidance/projectAgentGuidanceSections.js";

interface Context {
  params: Record<string, string>;
}

/** One active drift finding as the AGENT page's drift cards read it (issue #1630). */
interface ProjectGuidanceDriftFindingView {
  id: string;
  kind: "permission" | "behavior";
  claim: string;
  severity: "blocking" | "warning";
  firstSeenAt: string;
  evidence: { runIds: string[]; count: number } | { guidanceExcerpt: string; manifestFacts: string[] };
  suggestedAllowedLine: string | null;
  suggestedNotAllowedLine: string | null;
}

function toView(finding: GuidanceDriftFinding): ProjectGuidanceDriftFindingView {
  const payload = finding.payload;
  const common = { id: finding.id, claim: payload.claim, severity: payload.severity, firstSeenAt: finding.firstSeenAt };
  if (payload.kind === "behavior") {
    return {
      ...common,
      kind: "behavior",
      evidence: { runIds: payload.evidence.runIds, count: payload.evidence.count },
      suggestedAllowedLine: payload.suggestedAllowedLine,
      suggestedNotAllowedLine: payload.suggestedNotAllowedLine,
    };
  }
  // No suggestion is generated for a permission finding.
  return {
    ...common,
    kind: "permission",
    evidence: { guidanceExcerpt: payload.guidanceExcerpt, manifestFacts: payload.manifestFacts },
    suggestedAllowedLine: null,
    suggestedNotAllowedLine: null,
  };
}

/**
 * Oldest first: `firstSeenAt`, then `id`. `firstSeenAt` is the fixed-width UTC ISO form of the
 * column, which `upsertActive` writes only from a JS `Date` (millisecond precision), so comparing
 * the strings orders exactly like the column; lowercase UUID text compares like the `uuid` order.
 */
function compareFindings(left: GuidanceDriftFinding, right: GuidanceDriftFinding): number {
  if (left.firstSeenAt !== right.firstSeenAt) return left.firstSeenAt < right.firstSeenAt ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

async function readDrift(tx: PoolClient, projectItemId: string) {
  try {
    await guidanceReferenceStore.requireProjectsItem(tx, projectItemId);
  } catch (error) {
    if (error instanceof GuidanceReferenceNotFoundError) throw new NotFoundError("Project not found");
    throw error;
  }
  const guidance = await projectAgentGuidanceStore.load(tx, projectItemId);
  // A project without guidance has nothing its findings could be resolved against, so it answers an
  // empty list even when an active finding row exists (gh-1630: "no guidance or no finding").
  if (!guidance) return { guidanceUpdatedAt: null, findings: [] };
  // `listActive` returns only `status = 'active'` rows, so a resolved finding is never listed.
  const findings = await agentGuidanceDriftFindingsStore.listActive(tx, projectItemId);
  return {
    guidanceUpdatedAt: guidance.updatedAt,
    findings: [...findings].sort(compareFindings).map(toView),
  };
}

/**
 * `GET /api/projects/:id/agent-guidance/drift` (issue #1630): the project's active drift findings
 * and the guidance `updatedAt` the client passes back when it resolves one; without guidance, an
 * empty list and `null`. The project check, the guidance read and the findings read share one
 * REPEATABLE READ transaction, so the version and the list come from the same snapshot. Another
 * tenant's project is invisible under row-level security and answers the same 404 as an unknown id.
 */
export function createProjectGuidanceDriftReadRouteHandler(pool: Pool) {
  return async (ctx: Context) => {
    const parsed = z.string().uuid().safeParse(ctx.params.id);
    if (!parsed.success) throw new ValidationError("Project id must be a UUID", { field: "id" });
    const body = await withTransaction(pool, (tx) => readDrift(tx, parsed.data), { isolation: "repeatable_read" });
    return { status: 200, body };
  };
}

const decisionSchema = z.object({
  choice: z.enum(["allow", "forbid", "dismiss"]),
  expectedGuidanceUpdatedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export function createResolveGuidanceDriftFindingRouteHandler(pool: Pool) {
  return async (ctx: Context & { body: unknown; identity: { user: { id: string } } }) => {
    const id = z.string().uuid().safeParse(ctx.params.id);
    const decision = decisionSchema.safeParse(ctx.body);
    if (!id.success) throw new ValidationError("Finding id must be a UUID", { field: "id" });
    if (!decision.success) throw new ValidationError("Invalid decision", { field: "choice" });
    try {
      const body = await withTransaction(pool, (tx) => resolveGuidanceDriftFinding(tx, {
        findingId: id.data, actorUserId: ctx.identity.user.id, ...decision.data,
      }), { isolation: "serializable" });
      return { status: 200, body };
    } catch (error) {
      if (error instanceof ConflictError)
        return { status: 409, body: { error: { code: "version_conflict", details: error.details } } };
      if (typeof error === "object" && error !== null && "code" in error && error.code === "40001") {
        const current = await withTransaction(pool, async (tx) => {
          const row = await tx.query<{ project_item_id: string }>("SELECT project_item_id FROM agent_guidance_drift_findings WHERE id = $1", [id.data]);
          if (!row.rows[0]) throw new NotFoundError("Guidance drift finding not found");
          const value = await loadGuidanceSections(tx, row.rows[0].project_item_id);
          if (value.ownerUserId !== ctx.identity.user.id) throw new ForbiddenError("Guidance owner required", undefined, "owner_violation");
          return value;
        });
        return { status: 409, body: { error: { code: "version_conflict", details: { current } } } };
      }
      throw error;
    }
  };
}
