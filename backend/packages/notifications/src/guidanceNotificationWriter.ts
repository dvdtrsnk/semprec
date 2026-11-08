import type { PoolClient } from "pg";
import type { CreateGuidanceNotificationInput, GuidanceNotificationWriter } from "@semprec/shared";
import { createNotification } from "./createNotification.js";

/**
 * Concrete `PoolClient` implementation of `@semprec/shared`'s `GuidanceNotificationWriter`
 * (issue #85), adapting the two guidance-drift transitions onto this package's `createNotification`
 * — the same single write path `agent_run_error`, `heartbeat_error`, and the library/mail sync
 * jobs already use via `@semprec/data`'s `writeNotification`.
 *
 * `transitionInstance` is passed straight through from the caller (`driftAction.ts`), which
 * derives it from the fingerprint plus the run's `seenAt`/`resolvedAt` timestamp rather than the
 * fingerprint alone — a finding's `id` and fingerprint are both stable across a
 * resolved-then-reappeared cycle, so keying dedup on either alone would collide the reappearance
 * notification with the original and silently drop it.
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
