import type { PoolClient } from "pg";
import type { GuidanceProblemWriter } from "@semprec/shared";
import { raiseProblem, resolveProblem } from "./sempProblemsStore.js";
import { guidanceProblemKey } from "./sourceProblemKeys.js";

/**
 * Resolves the `guidanceDrift` problem of one finding in the caller's open transaction (issue #1915), as
 * `recovered`. It is the one resolve every path that ends a finding goes through: the drift passes (through the
 * writer below), the owner's decision (allow, forbid and dismiss: a decided finding is never reactivated, so
 * nothing else would close the problem) and the emptying of the project's guidance. Returns whether a problem
 * was active.
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

/**
 * `PoolClient` implementation of `@semprec/shared`'s `GuidanceProblemWriter` (issues #1465 and #1915): one
 * active `guidanceDrift` warning per finding, raised and resolved in the caller's transaction.
 */
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
