import type { PoolClient } from "pg";
import type { GuidanceProblemWriter } from "@semprec/shared";
import { raiseProblem } from "./sempProblemsStore.js";
import { guidanceProblemKey } from "./sourceProblemKeys.js";

/**
 * `PoolClient` implementation of `@semprec/shared`'s `GuidanceProblemWriter` (issue #1465): one
 * active `guidanceDrift` warning per finding, raised in the caller's transaction.
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
  };
}
