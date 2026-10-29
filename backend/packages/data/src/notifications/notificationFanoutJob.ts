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
  NotificationInterruptionLevel,
  NotificationPushPayload,
  PushSendResult,
  PushSenders,
} from "../push/pushSenders.js";
import type { PushSubscriptionRow } from "../push/types.js";
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

const defaultPushSenders: PushSenders = {
  sendWebPush: sendWebPushNotification,
  sendApns: sendApnsNotification,
};

function webPushTarget(registration: PushSubscriptionRow): { endpoint: string; p256dh: string; authSecret: string } {
  if (registration.endpoint === null || registration.p256dh === null || registration.authSecret === null) {
    throw new Error(`push_subscriptions row ${registration.id} is channel 'web_push' but missing web push fields`);
  }
  return { endpoint: registration.endpoint, p256dh: registration.p256dh, authSecret: registration.authSecret };
}

function apnsTarget(registration: PushSubscriptionRow): {
  deviceToken: string;
  apnsEnvironment: "sandbox" | "production";
} {
  if (registration.deviceToken === null || registration.apnsEnvironment === null) {
    throw new Error(`push_subscriptions row ${registration.id} is channel 'apns' but missing APNs fields`);
  }
  return { deviceToken: registration.deviceToken, apnsEnvironment: registration.apnsEnvironment };
}

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

export interface HandleNotificationFanoutInput {
  notificationId: string;
}

/**
 * The `notificationFanout` job's handler (issue #151): loads every active registration for the
 * notification's user and dispatches each through its channel's adapter. Before any registration is
 * loaded, the user's preferences (the stored row, or the defaults without one) and the kind's policy
 * decide whether this notification is pushed at all (issue #1443, `pushInterruptionLevelFor`). When
 * it is not, the job returns without claiming delivery rows; the notification row itself stays, so
 * the in-app list still shows it. Preferences are read when the job runs, so a change made after the
 * notification was enqueued is honored. `push_deliveries`
 * (migration 0032) is the durable per-(notification, registration) dedup key the issue's Task
 * requires: `claimPushDeliveryTargets` claims a row per active registration exactly once (`ON
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
  senders: PushSenders = defaultPushSenders,
): Promise<void> {
  const notification = await withTransaction(pool, (client) => getNotificationById(client, input.notificationId));
  if (!notification) return;

  const preferences = await withTransaction(pool, (client) => getNotificationPreferences(client, notification.userId));
  const interruptionLevel = pushInterruptionLevelFor(policyForNotification(notification), preferences);
  if (interruptionLevel === null) return;

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

  const payload: NotificationPushPayload = {
    notificationId: notification.id,
    title: notification.title,
    body: notification.body,
    linkHref: notification.linkHref,
    interruptionLevel,
  };
  const transientFailures: unknown[] = [];
  const loggedNotConfiguredChannels = new Set<PushSubscriptionRow["channel"]>();

  for (const registration of activeRegistrations) {
    const status = statusByRegistrationId.get(registration.id);
    if (!status || status.delivered || status.failedPermanently) continue;

    let result: PushSendResult;
    switch (registration.channel) {
      case "web_push":
        result = await senders.sendWebPush(webPushTarget(registration), payload);
        break;
      case "apns":
        result = await senders.sendApns(apnsTarget(registration), payload);
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
