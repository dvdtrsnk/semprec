import type { PoolClient } from "pg";
import type { CreateGuidanceNotificationInput, GuidanceNotificationWriter } from "@semprec/shared";
import { createNotification } from "./createNotification.js";

/**
 * `PoolClient` implementation of `GuidanceNotificationWriter`, mapping the two guidance-drift
 * transitions onto `createNotification`. `transitionInstance` comes from `driftAction.ts` as
 * fingerprint plus `seenAt`/`resolvedAt`: a finding's id and fingerprint are stable across a
 * resolve-then-reappear cycle, so keying dedup on either alone would drop the reappearance.
 */
export function createGuidanceNotificationWriter(): GuidanceNotificationWriter<PoolClient> {
  return {
    async create(tx, input: CreateGuidanceNotificationInput) {
      await createNotification(tx, {
        userId: input.userId,
        kind: input.kind,
        linkHref: input.linkHref,
        sourceTable: input.sourceTable,
        sourceId: input.sourceId,
        transitionInstance: input.transitionInstance,
        payload: input.payload,
      });
    },
  };
}
