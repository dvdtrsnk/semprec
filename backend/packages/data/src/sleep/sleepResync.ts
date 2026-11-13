import type { PoolClient } from "pg";
import { z } from "zod";
import { enqueueJob, type Task } from "@semprec/queue";
import { createLogger, currentTenantScope } from "@semprec/shared";
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

/** The name of the job this module declares in `sleepModuleManifest.ts` (issue gh-1838). */
export const SLEEP_RESYNC_TASK_NAME = "sleep.resync";

/** How long after a sleep change the push is sent; a change inside the window moves the push to its own end. */
export const SLEEP_RESYNC_DELAY_MS = 30_000;

/** The silent push the iOS registrations receive: the device then reads `GET /api/sleep/nights` again. */
const SLEEP_RESYNC_PUSH_DATA = { kind: "sleepResync" } as const;

/**
 * The payload of a `sleep.resync` job: the tenant whose sleep data changed, and nothing else. The handler does not
 * take its tenant from it; it runs in the tenant of the job's envelope and checks that the payload names that one.
 */
export const sleepResyncPayloadSchema = z.strictObject({ tenantId: z.uuid() });

type SleepResyncPayload = z.infer<typeof sleepResyncPayloadSchema>;

/**
 * Enqueues the `sleep.resync` job of `tenantId` on `client`, so it commits or rolls back with the write that
 * changed the sleep data. The job key is `sleep-resync:<tenantId>` with `jobKeyMode: "replace"` and a run time
 * `SLEEP_RESYNC_DELAY_MS` from now, so a job still waiting is replaced and its run time moves: any number of
 * changes inside the window leave one pending job, and one push goes out `SLEEP_RESYNC_DELAY_MS` after the last.
 * A job that is running when the next change arrives is not replaced; the change queues a second job.
 */
export async function enqueueSleepResync(client: PoolClient, tenantId: string): Promise<void> {
  await enqueueJob(client, SLEEP_RESYNC_TASK_NAME, { tenantId } satisfies SleepResyncPayload, {
    jobKey: `sleep-resync:${tenantId}`,
    jobKeyMode: "replace",
    runAt: new Date(Date.now() + SLEEP_RESYNC_DELAY_MS),
  });
}

/** Runs `fn` on a pooled client of the job's tenant scope and releases the client afterwards. */
type SleepResyncClientRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

/** Sends the silent push to one iOS registration; the seam that tests replace. */
export type SleepResyncSender = (target: ApnsTarget, data: typeof SLEEP_RESYNC_PUSH_DATA) => Promise<PushSendResult>;

/** An active registration of an iPhone or iPad: an APNs registration on platform `ios` that is not revoked. */
function isActiveIosRegistration(registration: PushSubscriptionRow): boolean {
  return registration.channel === "apns" && registration.platform === "ios" && registration.revokedAt === null;
}

/**
 * The job's work (issue gh-1838): one silent background push `{ kind: "sleepResync" }` to every active iOS APNs
 * registration of the user of the job's tenant. A macOS, a Web Push and a revoked registration get nothing, and a
 * tenant without a user or without a registration is a successful no-op. The registrations are read first and
 * the sends run on no client, so no connection is held across a network call.
 *
 * Every registration is tried. A `permanent-failure` revokes that registration through
 * `revokePushSubscriptionByProviderInvalidation`. `not-configured` neither revokes nor retries, because the gap is
 * the server's; it is logged once. A `transient-failure` is thrown after the other registrations were tried, so
 * the queue runs the job again and the retry sends to every active registration again; a repeated silent push is
 * harmless to the device. No `notifications` and no `push_deliveries` row is written.
 *
 * `payload` must name the tenant of the job's own scope (`currentTenantScope()`), which is the tenant the queue
 * stamped at enqueue. A payload that names another tenant, or a run outside a tenant scope, sends nothing and
 * is logged with ids only. A payload that is not `{ tenantId }` fails the job.
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

/**
 * The handler of the `sleep.resync` module task (`sleepModuleManifest.ts`): `runSleepResync` on the clients of
 * the queue worker's pool, which `registerTask` has put in the tenant scope of the job's envelope. The queue
 * passes the payload already parsed with `sleepResyncPayloadSchema`; `runSleepResync` parses it again.
 */
export const handleSleepResync: Task = async (payload, helpers) => {
  await runSleepResync(payload, (fn) => helpers.withPgClient(fn));
};
