import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { getMailAccountSyncStateByGraphSubscriptionId, routeGraphSubscription } from "./mailAccountSyncStateStore.js";
import { enqueueMailAccountSync } from "./mailSyncJob.js";

export interface GraphChangeNotification {
  subscriptionId: string;
  /** Absent (not just mismatched) is itself a rejection — a notification with no `clientState` at all can never be a genuine Graph delivery, since Graph always echoes back whatever the subscription was created with. */
  clientState?: string;
}

export type GraphNotificationOutcome = "accepted" | "unknownSubscription" | "invalidClientState";

/**
 * Digests both sides to a fixed-length hash before comparing: `timingSafeEqual` throws on a
 * length mismatch rather than returning `false`, and a raw-string length mismatch would itself
 * be an observable timing signal (io-hardening: "compare secrets in constant time") — hashing
 * first removes both problems at once.
 */
function clientStateMatches(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

/** Compared against whenever there is no real stored state, so every path costs one compare. */
const DUMMY_CLIENT_STATE = randomBytes(32).toString("hex");

/**
 * Handles one inbound Microsoft Graph change notification (issue #198's webhook receiver,
 * `graphWebhookHandler.ts` in `semprec-api`) — turns a valid notification into the same
 * idempotent `enqueueMailAccountSync` job every sync mode shares (never a direct `/messages/delta`
 * call or ingestion here), the same "no direct Email mutation in callback" discipline issue
 * #196/#197 established for IMAP IDLE and Gmail Pub/Sub. A duplicate or redelivered notification
 * for the same account collapses into that job's own `jobKey` dedup, so calling this twice for
 * the same change is always safe.
 *
 * The caller has no tenant (the webhook is public), so the owning tenant comes from
 * `routeGraphSubscription` in its own transaction in the caller's scope. The account re-read, the
 * `clientState` check and the enqueue then run inside `runInTenant(<that tenant>)`, so the job
 * envelope carries the tenant. A `subscriptionId` no tenant registered, or a `clientState` that
 * doesn't match what was persisted when the subscription was registered
 * (`graphWebhookLifecycle.ts`), is rejected without enqueueing anything — the caller decides what a
 * rejection means for its own response to Graph (issue #198's "invalid state rejected").
 *
 * Every path performs exactly one `clientStateMatches` call — against a fixed dummy secret when
 * the subscription is unknown, the row vanished or no state is stored, against `""` when the
 * notification has none — so the outcome is not observable from timing. Only a real match on a
 * stored state is accepted.
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
