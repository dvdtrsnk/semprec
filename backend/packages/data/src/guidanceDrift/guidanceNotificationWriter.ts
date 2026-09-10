import type { PoolClient } from "pg";
import type { CreateGuidanceNotificationInput, GuidanceNotificationWriter } from "@semprec/shared";
import { writeNotification } from "../notifications/notify.js";

/**
 * Concrete `PoolClient` implementation of `@semprec/shared`'s `GuidanceNotificationWriter`
 * (issue #85), adapting the two guidance-drift transitions onto the existing notifications
 * writer (`notify.ts`, issue #152/#237) rather than a separate `createNotification` — this
 * codebase already centralizes "insert the row + enqueue fanout in the same transaction" there.
 *
 * `transitionInstance` is the finding's own fingerprint: a replayed drift action observing the
 * same still-active (or still-resolved) finding again must not re-notify, but a finding that
 * resolves and later reappears with the very same fingerprint is a new problem and must notify
 * again. Keying on the fingerprint alone (not e.g. a timestamp) achieves exactly that.
 */
export function createGuidanceNotificationWriter(): GuidanceNotificationWriter<PoolClient> {
  return {
    async create(tx, input: CreateGuidanceNotificationInput) {
      await writeNotification(tx, {
        userId: input.userId,
        kind: input.kind,
        linkHref: input.linkHref,
        sourceTable: input.sourceTable,
        sourceId: input.sourceId,
        transitionInstance: input.payload.fingerprint as string,
        payload: input.payload,
      });
    },
  };
}
