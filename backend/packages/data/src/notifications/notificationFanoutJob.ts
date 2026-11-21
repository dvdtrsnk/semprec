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
import { computeBadgeForUser } from "./badgeCount.js";
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

/** The notification-level `jobKey` collapses a duplicate enqueue onto the same job. */
export async function enqueueNotificationFanout(client: PoolClient, notificationId: string): Promise<void> {
  await enqueueJob(
    client,
    CORE_TASK_NAMES.NOTIFICATION_FANOUT,
    { notificationId },
    { jobKey: notificationFanoutJobKey(notificationId), jobKeyMode: "preserve_run_at", maxAttempts: 10 },
  );
}

/**
 * Keyed by wake time: a repeated hold until the same time collapses, a later one gets its own job.
 * If the keyed job is the one running, graphile-worker adds a new job with the same key.
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

/** `null` sends now. A failed sleep-data read also answers `null`, so it can never hold a push back. */
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
 * The APNs interruption level, or `null` for no push and no delivery rows. For problems, the
 * summary switch only changes the level, never whether the push is sent.
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
    case "calendarChanges":
      return preferences.calendarChanges ? "active" : null;
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

/** A Semp problem is never `info`. */
const PAYLOAD_PROBLEM_SEVERITIES = ["critical", "warning"] as const;

/**
 * A `semp_problem` takes its severity from `payload.severity`; a missing or unknown one is a broken
 * write, so the job throws rather than guess.
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

/** Must match the category the app registers its Approve/Reject/Open actions under. */
const APPROVAL_PUSH_CATEGORY = "APPROVAL_REQUEST";

/** Must match the category the app registers its Accept/Maybe/Decline actions under. */
const CALENDAR_INVITATION_PUSH_CATEGORY = "CALENDAR_INVITATION";

/** Only ids go on the wire; the visible body is the one rendered at write time. */
function apnsFieldsFor(notification: NotificationRow): NotificationApnsFields | undefined {
  if (notification.kind === "approval_pending" && notification.sourceTable === "approval_requests") {
    return { category: APPROVAL_PUSH_CATEGORY, approvalRequestId: notification.sourceId };
  }
  if (notification.kind === "calendar_invitation" && notification.sourceTable === "items") {
    return { category: CALENDAR_INVITATION_PUSH_CATEGORY, data: { invitation_id: notification.sourceId } };
  }
  if (policyForKind(notification.kind).category === "calendarChanges") {
    // A summary of several changes names only its calendar, so the app opens no single Event for it.
    const { eventId, calendarId } = notification.payload;
    return {
      data: {
        ...(typeof calendarId === "string" ? { calendar_id: calendarId } : {}),
        ...(typeof eventId === "string" ? { event_id: eventId } : {}),
      },
    };
  }
  return undefined;
}

export interface HandleNotificationFanoutInput {
  notificationId: string;
}

export interface NotificationFanoutDependencies extends PushSenders {
  /** Clock seam for the sleep-window check. */
  now?: () => Date;
}

/**
 * Preferences are read when the job runs, so later changes are honored; a filtered notification
 * stays in the in-app list. Non-approval pushes inside the sleep window are re-enqueued for the
 * wake time, which re-checks (a wake time moved earlier does not send earlier).
 *
 * `push_deliveries` is the durable per-(notification, registration) dedup key, so a retried job
 * never sends a pair twice. Transient failures are collected and rethrown after every pending
 * registration was attempted. A permanent failure revokes that registration. `not-configured` is
 * the server's gap, not the device's: it fails the delivery permanently without revoking, and logs
 * once per channel instead of retrying a channel that cannot become configured mid-retry.
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

  // Computed after the filters so a held or filtered notification costs no badge query.
  const badge = await withTransaction(pool, (client) => computeBadgeForUser(client, notification.userId));
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
    badge,
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
