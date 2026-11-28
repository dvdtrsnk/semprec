import type { PoolClient } from "pg";
import { z } from "zod";
import { enqueueJob, type Task } from "@alldots/queue";
import { createLogger, currentTenantScope } from "@alldots/shared";
import { getTenantUserId } from "../auth/usersStore.js";
import { sendApnsBackgroundPush } from "../push/apnsAdapter.js";
import type { ApnsTarget, PushSendResult } from "../push/pushSenders.js";
import {
  listPushSubscriptionsForUser,
  revokePushSubscriptionByProviderInvalidation,
} from "../push/pushSubscriptionsStore.js";
import { apnsTarget } from "../push/pushTargets.js";
import type { PushSubscriptionRow } from "../push/types.js";

const logger = createLogger("sleep");

export const SLEEP_RESYNC_TASK_NAME = "sleep.resync";

/** A change inside the window moves the push to the window's end. */
export const SLEEP_RESYNC_DELAY_MS = 30_000;

/** The device then reads `GET /api/sleep/nights` again. */
const SLEEP_RESYNC_PUSH_DATA = { kind: "sleepResync" } as const;

/** The handler runs in the envelope's tenant and only checks the payload names that one. */
export const sleepResyncPayloadSchema = z.strictObject({ tenantId: z.uuid() });

type SleepResyncPayload = z.infer<typeof sleepResyncPayloadSchema>;

/**
 * Enqueued on the write's client, so it commits or rolls back with it. `jobKeyMode: "replace"` debounces: changes
 * inside the window leave one pending job; a job already running is not replaced, so a second one queues.
 */
export async function enqueueSleepResync(client: PoolClient, tenantId: string): Promise<void> {
  await enqueueJob(client, SLEEP_RESYNC_TASK_NAME, { tenantId } satisfies SleepResyncPayload, {
    jobKey: `sleep-resync:${tenantId}`,
    jobKeyMode: "replace",
    runAt: new Date(Date.now() + SLEEP_RESYNC_DELAY_MS),
  });
}

type SleepResyncClientRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

/** Test seam. */
export type SleepResyncSender = (target: ApnsTarget, data: typeof SLEEP_RESYNC_PUSH_DATA) => Promise<PushSendResult>;

function isActiveIosRegistration(registration: PushSubscriptionRow): boolean {
  return registration.channel === "apns" && registration.platform === "ios" && registration.revokedAt === null;
}

/**
 * Silent push to every active iOS APNs registration of the tenant's user. Registrations are read first and sends
 * run on no client, so no connection is held across a network call. No `notifications`/`push_deliveries` row.
 *
 * `permanent-failure` revokes the registration; `not-configured` is the server's gap and is logged once without
 * revoke or retry; transient failures are thrown after all were tried so the job retries (a repeated silent push
 * is harmless). A payload naming a tenant other than the job's scope sends nothing.
 */
export async function runSleepResync(
  payload: unknown,
  runWithClient: SleepResyncClientRunner,
  send: SleepResyncSender = sendApnsBackgroundPush,
): Promise<void> {
  const input = sleepResyncPayloadSchema.parse(payload);
  const scope = currentTenantScope();
  if (scope?.kind !== "tenant" || scope.tenantId !== input.tenantId) {
    logger.warn({ payloadTenantId: input.tenantId, scopeKind: scope?.kind }, "sleep.resync names another tenant");
    return;
  }

  const registrations = await runWithClient(async (client) => {
    const userId = await getTenantUserId(client);
    return userId === null ? [] : listPushSubscriptionsForUser(client, userId);
  });

  const transientFailures: unknown[] = [];
  let loggedNotConfigured = false;
  for (const registration of registrations.filter(isActiveIosRegistration)) {
    const target = apnsTarget(registration);
    const result = await send(target, SLEEP_RESYNC_PUSH_DATA);
    switch (result.outcome) {
      case "delivered":
        break;
      case "permanent-failure":
        await runWithClient((client) =>
          revokePushSubscriptionByProviderInvalidation(client, { channel: "apns", deviceToken: target.deviceToken }),
        );
        break;
      case "not-configured":
        if (!loggedNotConfigured) {
          loggedNotConfigured = true;
          logger.warn(
            { tenantId: input.tenantId, reason: result.reason },
            "APNs is not configured; sleep.resync not sent",
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
      `sleep.resync: ${transientFailures.length} transient failure(s) for tenant ${input.tenantId}; job will retry`,
    );
  }
}

/** The worker has put the client in the envelope's tenant scope; `runSleepResync` re-parses the payload. */
export const handleSleepResync: Task = async (payload, helpers) => {
  await runSleepResync(payload, (fn) => helpers.withPgClient(fn));
};
