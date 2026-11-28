// What a provider's change notification does: route the channel to its tenant, check the secret the provider sent
// back, and queue a sync pass of the account. Nothing is fetched here; the pass reads the changes.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant } from "@alldots/shared";
import { withTransaction } from "../../db/pool.js";
import { enqueueCalendarAccountSync } from "./calendarAccountSyncEnqueue.js";
import {
  getCalendarPushChannel,
  routeCalendarPushChannel,
  type CalendarPushProvider,
} from "./calendarPushChannelsStore.js";

export type CalendarPushNotificationOutcome = "accepted" | "unknownChannel" | "invalidSecret";

/** Hashing first avoids `timingSafeEqual`'s length-mismatch throw and the length timing signal. */
function secretMatches(expected: string, actual: string): boolean {
  return timingSafeEqual(createHash("sha256").update(expected).digest(), createHash("sha256").update(actual).digest());
}

/** Compared against when no channel is stored, so every path costs one comparison. */
const DUMMY_SECRET = randomBytes(32).toString("hex");

/**
 * `accepted` queues the account's pass (`calendar-account-sync:<account>`, so repeats queue one). With `enqueue:
 * false` a valid notification is accepted and queues nothing (Google's `sync` message after a channel is created).
 * An unknown channel and a wrong or missing secret queue nothing.
 */
export async function acceptCalendarPushNotification(
  pool: Pool,
  input: { provider: CalendarPushProvider; channelId: string; secret: string | null; enqueue?: boolean },
): Promise<CalendarPushNotificationOutcome> {
  const tenantId = await routeCalendarPushChannel(pool, input.provider, input.channelId);
  if (tenantId === null) {
    secretMatches(DUMMY_SECRET, input.secret ?? "");
    return "unknownChannel";
  }
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const channel = await getCalendarPushChannel(client, input.provider, input.channelId);
      const matches = secretMatches(channel?.secret ?? DUMMY_SECRET, input.secret ?? "");
      if (channel === null) return "unknownChannel";
      if (input.secret === null || !matches) return "invalidSecret";
      if (input.enqueue !== false) await enqueueCalendarAccountSync(client, channel.accountItemId);
      return "accepted";
    }),
  );
}
