import type { Pool, PoolClient } from "pg";
import { enqueueJob, CORE_TASK_NAMES } from "@semprec/queue";
import { withTransaction } from "../db/pool.js";
import { assertKnownValue } from "../dbRowValidation.js";
import { getNotificationById, type NotificationRow } from "./notificationsStore.js";
import {
  listPushSubscriptionsForUser,
  revokePushSubscriptionByProviderInvalidation,
} from "../push/pushSubscriptionsStore.js";
import {
  claimPushDeliveryTargets,
  getPushDeliveryStatuses,
  markPushDeliveryDelivered,
  markPushDeliveryFailedPermanently,
  recordPushDeliveryTransientFailure,
} from "../push/pushDeliveriesStore.js";
import { sendWebPushNotification } from "../push/webPushAdapter.js";
import { sendApnsNotification } from "../push/apnsAdapter.js";
import type {
  NotificationApnsFields,
  NotificationInterruptionLevel,
  NotificationPushPayload,
  PushSendResult,
  PushSenders,
} from "../push/pushSenders.js";
import { apnsTarget, webPushTarget } from "../push/pushTargets.js";
import type { PushSubscriptionRow } from "../push/types.js";
import { findSleepMuteUntil } from "../sleep/sleepMuteWindow.js";
import { logger } from "./logger.js";
import { policyForKind, type NotificationKindPolicy, type NotificationSeverity } from "./notificationKinds.js";
import {
  getNotificationPreferences,
  type NotificationPreferences,
  type NotificationProblemsLevel,
} from "./notificationPreferencesStore.js";

export function notificationFanoutJobKey(notificationId: string): string {
  return `notification-fanout:${notificationId}`;
}

/**
 * Enqueues the `notificationFanout` job (issue #151's Task: "one graphile-worker fanout job for
 * each committed notification using a notification-level jobKey"). `writeNotification` is the
 * only caller — its own dedup on `(sourceTable, sourceId, kind, transitionInstance)` decides
 * whether a notification is genuinely new, and this is only invoked when it is, but the
 * `jobKey` derived from the notification's own id makes a duplicate enqueue collapse onto the
 * same job either way.
 */
export async function enqueueNotificationFanout(client: PoolClient, notificationId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.NOTIFICATION_FANOUT,
    { notificationId },
    { jobKey: notificationFanoutJobKey(notificationId), jobKeyMode: "preserve_run_at", maxAttempts: 10 },
  );
}

/**
 * Enqueues the `notificationFanout` job that sends a held notification's push at `wakeAt` (issue #1794).
 * The key ends with the wake time as a UTC ISO string. A repeated hold until the same wake time
 * therefore collapses onto the job queued for it, which keeps its run time, and a later wake time gets
 * a job of its own. When the job with that key is the one running, graphile-worker adds a new job
 * with the same key instead.
 */
async function enqueueDeferredNotificationFanout(
  client: PoolClient,
  notificationId: string,
  wakeAt: Date,
): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.NOTIFICATION_FANOUT,
    { notificationId },
    {
      jobKey: `notification-fanout-deferred:${notificationId}:${wakeAt.toISOString()}`,
      jobKeyMode: "preserve_run_at",
      maxAttempts: 10,
      runAt: wakeAt,
    },
  );
}

/**
 * The wake time until which the push of this notification is held, or `null` to send it now
 * (issue #1794). A failure to read or resolve the tenant's sleep data also answers `null`, so it
 * cannot keep a push back; it is logged with the notification id and the error's name.
 */
async function sleepMuteUntilOrNull(pool: Pool, notificationId: string, now: Date): Promise<Date | null> {
  try {
    return await withTransaction(pool, (client) => findSleepMuteUntil(client, now));
  } catch (error) {
    logger.error(
      { notificationId, errorName: error instanceof Error ? error.name : typeof error },
      "Sleep window check failed; the push is sent without it",
    );
    return null;
  }
}

const defaultPushSenders: PushSenders = {
  sendWebPush: sendWebPushNotification,
  sendApns: sendApnsNotification,
};

/**
 * Whether a notification of this policy is pushed to its user under these preferences, and at which
 * APNs interruption level (issue #1443). `null` means no push and no delivery rows. Approvals follow
 * their category switch and are `time-sensitive`. Invitations and reminders follow their switches and
 * are `active`. Problems follow `problemsLevel` by severity: `critical` passes only critical, `all`
 * passes critical and warning, `off` passes nothing. The summary switch only sets the level, so with
 * it on a critical problem is `time-sensitive` and a warning is `passive`; with it off both are
 * `active`. `info` never reaches a push because its policy has `push: false`.
 */
export function pushInterruptionLevelFor(
  policy: NotificationKindPolicy,
  preferences: NotificationPreferences,
): NotificationInterruptionLevel | null {
  if (!policy.push) return null;
  switch (policy.category) {
    case "approvals":
      return preferences.approvals ? "time-sensitive" : null;
    case "invites":
      return preferences.invites ? "active" : null;
    case "reminders":
      return preferences.reminders ? "active" : null;
    case "problems":
      if (!problemsLevelIncludes(preferences.problemsLevel, policy.severity)) return null;
      if (!preferences.problemsSummary) return "active";
      return policy.severity === "critical" ? "time-sensitive" : "passive";
  }
}

function problemsLevelIncludes(level: NotificationProblemsLevel, severity: NotificationSeverity): boolean {
  switch (level) {
    case "off":
      return false;
    case "critical":
      return severity === "critical";
    case "all":
      return severity === "critical" || severity === "warning";
  }
}

/** The severities a `semp_problem` notification may carry in its payload: a Semp problem is never `info`. */
const PAYLOAD_PROBLEM_SEVERITIES = ["critical", "warning"] as const;

/**
 * The fixed policy this notification is pushed under. A `semp_problem` has no fixed severity: its
 * `payload.severity` is the stored problem's severity, written by `raiseProblem` (issue #1466). A
 * payload without a known severity is a broken write, so the job throws rather than guess.
 */
function policyForNotification(notification: NotificationRow): NotificationKindPolicy {
  const policy = policyForKind(notification.kind);
  if (policy.category !== "problems" || policy.severity !== "payload") return policy;
  const severity = notification.payload.severity;
  if (typeof severity !== "string") {
    throw new Error(
      `notificationFanout: notification ${notification.id} (${notification.kind}) has no severity in its payload`,
    );
  }
  return {
    category: "problems",
    severity: assertKnownValue(PAYLOAD_PROBLEM_SEVERITIES, severity, "payload.severity"),
    push: policy.push,
  };
}

/** The APNs category the app registers the Approve, Reject and Open actions of an approval push against. */
const APPROVAL_PUSH_CATEGORY = "APPROVAL_REQUEST";

/**
 * The APNs-only fields of this notification's push (issue #1831): for an approval notification the action
 * category and the id of the request, which is the notification's `source_id`. Any other notification, and an
 * `approval_pending` one whose source is not an approval request, gets none. Only ids go on the wire: the body
 * of the push is the one rendered at write time (issue #1773).
 */
function apnsFieldsFor(notification: NotificationRow): NotificationApnsFields | undefined {
  if (notification.kind !== "approval_pending" || notification.sourceTable !== "approval_requests") return undefined;
  return { category: APPROVAL_PUSH_CATEGORY, approvalRequestId: notification.sourceId };
}

export interface HandleNotificationFanoutInput {
  notificationId: string;
}

/** What the handler takes from outside: the push senders and, for tests, a clock. */
export interface NotificationFanoutDependencies extends PushSenders {
  /** The clock of the sleep-window check (issue #1794). Production passes none and gets the real time. */
  now?: () => Date;
}

/**
 * The `notificationFanout` job's handler (issue #151): loads every active registration for the
 * notification's user and dispatches each through its channel's adapter. Before any registration is
 * loaded, the user's preferences (the stored row, or the defaults without one) and the kind's policy
 * decide whether this notification is pushed at all (issue #1443, `pushInterruptionLevelFor`). When
 * it is not, the job returns without claiming delivery rows; the notification row itself stays, so
 * the in-app list still shows it. Preferences are read when the job runs, so a change made after the
 * notification was enqueued is honored.
 *
 * A notification that passes the preference filter and is not of category `approvals` is then
 * checked against the user's sleep window (issue #1794, `findSleepMuteUntil`). Inside the window
 * the job enqueues the same task for the wake time and returns without loading registrations,
 * claiming delivery rows or sending; the notification row is untouched. The job that runs at the
 * wake time makes the same check, so a wake time moved later in the meantime holds the push once
 * more, and a wake time moved earlier does not send it earlier. A failed check does not hold.
 * That job is a second job for the same notification; the decision record
 * `2026-11-12-a-push-inside-the-sleep-window-is-held-by-a-deferred-fan-out-job` names the case in
 * which it can run at the same time as the first one.
 *
 * `push_deliveries` (migration 0032) is the durable per-(notification, registration) dedup key the issue's
 * Task requires: `claimPushDeliveryTargets` claims a row per active registration exactly once (`ON
 * CONFLICT DO NOTHING` on every retry), and only a delivery that is still neither delivered nor
 * permanently failed is ever dispatched — so a redelivered/retried queue job can never send the
 * same (notification, registration) pair twice.
 *
 * A transient failure on any registration is collected and, after every other pending
 * registration has still been attempted, rethrown so graphile-worker retries the whole job. A
 * permanent one (provider 404/410/BadDeviceToken) invalidates just that registration via #150's
 * `revokePushSubscriptionByProviderInvalidation` and is never retried. A `not-configured` result
 * (issue #703, the server having no usable credentials for the channel at all) also marks the
 * delivery permanently failed, but never revokes the registration — the gap is the server's, not
 * a verdict on this device/subscription — and logs one warning per job and channel instead of
 * letting the job retry ten times against a channel that will never become configured mid-retry.
 */
export async function handleNotificationFanoutTask(
  pool: Pool,
  input: HandleNotificationFanoutInput,
  dependencies: NotificationFanoutDependencies = defaultPushSenders,
): Promise<void> {
  const notification = await withTransaction(pool, (client) => getNotificationById(client, input.notificationId));
  if (!notification) return;

  const preferences = await withTransaction(pool, (client) => getNotificationPreferences(client, notification.userId));
  const policy = policyForNotification(notification);
  const interruptionLevel = pushInterruptionLevelFor(policy, preferences);
  if (interruptionLevel === null) return;

  if (policy.category !== "approvals") {
    const now = dependencies.now ?? (() => new Date());
    const muteUntil = await sleepMuteUntilOrNull(pool, notification.id, now());
    if (muteUntil !== null) {
      await withTransaction(pool, (client) => enqueueDeferredNotificationFanout(client, notification.id, muteUntil));
      return;
    }
  }

  const registrations = await withTransaction(pool, (client) =>
    listPushSubscriptionsForUser(client, notification.userId),
  );
  const activeRegistrations = registrations.filter((registration) => registration.revokedAt === null);

  await withTransaction(pool, (client) =>
    claimPushDeliveryTargets(
      client,
      notification.id,
      activeRegistrations.map((registration) => registration.id),
    ),
  );

  const statuses = await withTransaction(pool, (client) => getPushDeliveryStatuses(client, notification.id));
  const statusByRegistrationId = new Map(statuses.map((status) => [status.pushSubscriptionId, status]));

  const apns = apnsFieldsFor(notification);
  const payload: NotificationPushPayload = {
    notificationId: notification.id,
    title: notification.title,
    body: notification.body,
    linkHref: notification.linkHref,
    interruptionLevel,
    sourceTable: notification.sourceTable,
    sourceId: notification.sourceId,
    kind: notification.kind,
    ...(apns === undefined ? {} : { apns }),
  };
  const transientFailures: unknown[] = [];
  const loggedNotConfiguredChannels = new Set<PushSubscriptionRow["channel"]>();

  for (const registration of activeRegistrations) {
    const status = statusByRegistrationId.get(registration.id);
    if (!status || status.delivered || status.failedPermanently) continue;

    let result: PushSendResult;
    switch (registration.channel) {
      case "web_push":
        result = await dependencies.sendWebPush(webPushTarget(registration), payload);
        break;
      case "apns":
        result = await dependencies.sendApns(apnsTarget(registration), payload);
        break;
      default: {
        const _exhaustive: never = registration.channel;
        throw new Error(`notificationFanout: unhandled push channel ${String(_exhaustive)}`);
      }
    }

    if (result.outcome === "delivered") {
      await withTransaction(pool, (client) => markPushDeliveryDelivered(client, status.id));
    } else if (result.outcome === "permanent-failure") {
      await withTransaction(pool, async (client) => {
        await markPushDeliveryFailedPermanently(client, status.id, String(result.error));
        await revokePushSubscriptionByProviderInvalidation(
          client,
          registration.channel === "web_push"
            ? { channel: "web_push", endpoint: webPushTarget(registration).endpoint }
            : { channel: "apns", deviceToken: apnsTarget(registration).deviceToken },
        );
      });
    } else if (result.outcome === "not-configured") {
      await withTransaction(pool, (client) => markPushDeliveryFailedPermanently(client, status.id, result.reason));
      if (!loggedNotConfiguredChannels.has(registration.channel)) {
        loggedNotConfiguredChannels.add(registration.channel);
        logger.warn(
          { notificationId: notification.id, channel: registration.channel, reason: result.reason },
          "Push channel is not configured; delivery marked permanently failed",
        );
      }
    } else {
      transientFailures.push(result.error);
      await withTransaction(pool, (client) =>
        recordPushDeliveryTransientFailure(client, status.id, String(result.error)),
      );
    }
  }

  if (transientFailures.length > 0) {
    throw new Error(
      `notificationFanout: ${transientFailures.length} transient delivery failure(s) for notification ${notification.id}; job will retry`,
    );
  }
}
