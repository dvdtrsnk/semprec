import type { PoolClient } from "pg";
import type { GuidanceProblemWriter } from "@alldots/shared";
import { raiseProblem, resolveProblem } from "./sempProblemsStore.js";
import { guidanceProblemKey } from "./sourceProblemKeys.js";

/**
 * Resolves the `guidanceDrift` problem of one finding as `recovered`. Every path that ends a finding goes
 * through here: the drift passing, the owner's decision (decided findings never reactivate) and emptying the
 * project's guidance. Returns whether a problem was active.
 */
export function resolveGuidanceDriftProblem(
  tx: PoolClient,
  input: { projectItemId: string; fingerprint: string },
): Promise<boolean> {
  return resolveProblem(tx, {
    dedupeKey: guidanceProblemKey(input.projectItemId, input.fingerprint),
    resolutionKind: "recovered",
  });
}

/** One active `guidanceDrift` warning per finding, raised and resolved in the caller's transaction. */
export function createGuidanceProblemWriter(): GuidanceProblemWriter<PoolClient> {
  return {
    async raise(tx, input) {
      await raiseProblem(tx, {
        userId: input.userId,
        category: "guidance",
        kind: "guidanceDrift",
        severity: "warning",
        sourceTable: "agent_guidance_drift_findings",
        sourceId: input.findingId,
        dedupeKey: guidanceProblemKey(input.projectItemId, input.fingerprint),
        projectItemId: input.projectItemId,
        occurrenceKey: input.occurrenceKey,
      });
    },
    async resolve(tx, input) {
      await resolveGuidanceDriftProblem(tx, input);
    },
  };
}
