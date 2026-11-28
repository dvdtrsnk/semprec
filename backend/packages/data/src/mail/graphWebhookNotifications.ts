import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant } from "@alldots/shared";
import { withTransaction } from "../db/pool.js";
import { getMailAccountSyncStateByGraphSubscriptionId, routeGraphSubscription } from "./mailAccountSyncStateStore.js";
import { enqueueMailAccountSync } from "./mailSyncJob.js";

export interface GraphChangeNotification {
  subscriptionId: string;
  /** Absent is a rejection: Graph always echoes the subscription's `clientState`. */
  clientState?: string;
}

export type GraphNotificationOutcome = "accepted" | "unknownSubscription" | "invalidClientState";

/** Hashing first avoids `timingSafeEqual`'s length-mismatch throw and the length timing signal. */
function clientStateMatches(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

/** Compared against whenever there is no real stored state, so every path costs one compare. */
const DUMMY_CLIENT_STATE = randomBytes(32).toString("hex");

/**
 * A valid notification only enqueues the idempotent sync job (jobKey dedup makes repeats safe).
 * The webhook is public, so the tenant is routed from the subscription id first, then the
 * re-read, `clientState` check and enqueue run inside that tenant. Unknown subscriptions and
 * mismatched states enqueue nothing.
 *
 * Every path does exactly one `clientStateMatches` call (against a dummy secret when nothing is
 * stored) so the outcome is not observable from timing.
 */
export async function handleGraphChangeNotification(
  pool: Pool,
  notification: GraphChangeNotification,
): Promise<GraphNotificationOutcome> {
  const tenantId = await withTransaction(pool, (client) => routeGraphSubscription(client, notification.subscriptionId));
  if (tenantId === null) {
    clientStateMatches(DUMMY_CLIENT_STATE, notification.clientState ?? "");
    return "unknownSubscription";
  }

  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const state = await getMailAccountSyncStateByGraphSubscriptionId(client, notification.subscriptionId);
      const storedState = state?.graphClientState || null;
      const matches = clientStateMatches(storedState ?? DUMMY_CLIENT_STATE, notification.clientState ?? "");
      if (!state) return "unknownSubscription";
      if (!storedState || !notification.clientState || !matches) return "invalidClientState";

      await enqueueMailAccountSync(client, state.itemId);
      return "accepted";
    }),
  );
}
