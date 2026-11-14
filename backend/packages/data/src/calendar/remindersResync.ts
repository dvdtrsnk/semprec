// The silent reminders resync push (issue gh-1879): when something changes what `GET /api/calendar/reminders` would
// answer, the phone is told to fetch the feed again and schedule its local reminders anew. The server keeps no
// reminder state; the job only wakes the device. `calendar/remindersResyncHooks.ts` enqueues it from the writes that
// can change a fire time, `worker.ts` registers its handler.
// Constrained by: docs/adr/2026-11-14-a-reminders-change-enqueues-one-debounced-resync-job-per-tenant-in-its-write-transaction.md,
// which applies docs/adr/2026-11-13-a-sleep-change-enqueues-one-debounced-resync-job-per-tenant-in-its-write-transaction.md to reminders
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { currentTenantScope } from "@semprec/shared";
import { getTenantUserId } from "../auth/usersStore.js";
import { withTransaction } from "../db/pool.js";
import { sendApnsBackgroundPush } from "../push/apnsAdapter.js";
import type { ApnsTarget, PushSendResult } from "../push/pushSenders.js";
import {
  listPushSubscriptionsForUser,
  revokePushSubscriptionByProviderInvalidation,
} from "../push/pushSubscriptionsStore.js";
import { apnsTarget } from "../push/pushTargets.js";
import type { PushSubscriptionRow } from "../push/types.js";
import { logger } from "./logger.js";

/** How long after a change the push is sent; a change inside the window moves the push to its own end. */
export const REMINDERS_RESYNC_DELAY_MS = 30_000;

/** The silent push the iOS registrations receive: the device then reads `GET /api/calendar/reminders` again. */
const REMINDERS_RESYNC_PUSH_DATA = { kind: "remindersResync" } as const;

/**
 * The payload of a `remindersResync` job: the tenant whose reminders changed, and nothing else. The handler does not
 * take its tenant from it; it runs in the tenant of the job's envelope and checks that the payload names that one.
 */
const remindersResyncPayloadSchema = z.strictObject({ tenantId: z.uuid() });

/** The queue key of the pending resync of `tenantId`: at most one job per tenant waits under it. */
export function remindersResyncJobKey(tenantId: string): string {
  return `reminders-resync:${tenantId}`;
}

/**
 * Enqueues the `remindersResync` job of `tenantId` on `client`, so it commits or rolls back with the write that
 * changed a fire time. The job key is `reminders-resync:<tenantId>` with `jobKeyMode: "replace"` and a run time
 * `REMINDERS_RESYNC_DELAY_MS` from now, so a job still waiting is replaced and its run time moves: any number of
 * changes inside the window leave one pending job, and one push goes out `REMINDERS_RESYNC_DELAY_MS` after the last.
 * A job that is running when the next change arrives is not replaced; the change queues a second job.
 */
export async function enqueueRemindersResync(client: PoolClient, tenantId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.REMINDERS_RESYNC,
    { tenantId },
    {
      jobKey: remindersResyncJobKey(tenantId),
      jobKeyMode: "replace",
      runAt: new Date(Date.now() + REMINDERS_RESYNC_DELAY_MS),
    },
  );
}

/** Sends the silent push to one iOS registration; the seam that tests replace. */
export type RemindersResyncSender = (
  target: ApnsTarget,
  data: typeof REMINDERS_RESYNC_PUSH_DATA,
) => Promise<PushSendResult>;

/** An active registration of an iPhone or iPad: an APNs registration on platform `ios` that is not revoked. */
function isActiveIosRegistration(registration: PushSubscriptionRow): boolean {
  return registration.channel === "apns" && registration.platform === "ios" && registration.revokedAt === null;
}

/**
 * The `remindersResync` job's handler (issue gh-1879): one silent background push `{ kind: "remindersResync" }`, with
 * no notification text, to every active iOS APNs registration of the user of the job's tenant. A macOS, a Web Push and
 * a revoked registration get nothing, and a tenant without a user or without a registration is a successful no-op
 * that attempts no push. The registrations are read first and the sends run on no client, so no connection is held
 * across a network call.
 *
 * Every registration is tried. A `permanent-failure` revokes that registration through
 * `revokePushSubscriptionByProviderInvalidation`. `not-configured` neither revokes nor retries, because the gap is the
 * server's; it is logged once. A `transient-failure` is thrown after the other registrations were tried, so the queue
 * runs the job again and the retry sends to every active registration again; a repeated silent push only makes the
 * device read the feed once more. No `notifications` and no `push_deliveries` row is written.
 *
 * `payload` must name the tenant of the job's own scope (`currentTenantScope()`), which is the tenant the queue stamped
 * at enqueue. A payload that names another tenant, or a run outside a tenant scope, sends nothing and is logged with
 * ids only. A payload that is not `{ tenantId }` fails the job.
 */
export async function handleRemindersResyncTask(
  pool: Pool,
  payload: unknown,
  send: RemindersResyncSender = sendApnsBackgroundPush,
): Promise<void> {
  const input = remindersResyncPayloadSchema.parse(payload);
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant" || scope.tenantId !== input.tenantId) {
    logger.warn({ payloadTenantId: input.tenantId, scopeKind: scope?.kind }, "remindersResync names another tenant");
    return;
  }

  const registrations = await withTransaction(pool, async (client) => {
    const userId = await getTenantUserId(client);
    return userId === null ? [] : listPushSubscriptionsForUser(client, userId);
  });

  const transientFailures: unknown[] = [];
  let loggedNotConfigured = false;
  for (const registration of registrations.filter(isActiveIosRegistration)) {
    const target = apnsTarget(registration);
    const result = await send(target, REMINDERS_RESYNC_PUSH_DATA);
    switch (result.outcome) {
      case "delivered":
        break;
      case "permanent-failure":
        await withTransaction(pool, (client) =>
          revokePushSubscriptionByProviderInvalidation(client, { channel: "apns", deviceToken: target.deviceToken }),
        );
        break;
      case "not-configured":
        if (!loggedNotConfigured) {
          loggedNotConfigured = true;
          logger.warn(
            { tenantId: input.tenantId, reason: result.reason },
            "APNs is not configured; remindersResync not sent",
          );
        }
        break;
      case "transient-failure":
        transientFailures.push(result.error);
        break;
    }
  }

  if (transientFailures.length > 0) {
    throw new AggregateError(
      transientFailures,
      `remindersResync: ${transientFailures.length} transient failure(s) for tenant ${input.tenantId}; job will retry`,
    );
  }
}
