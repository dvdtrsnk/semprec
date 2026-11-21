// Microsoft Graph subscriptions on an account's `/me/events`: create, renew in place, delete, and the webhook's
// notification. Graph validates `notificationUrl` while it creates the subscription, so the webhook must be reachable.
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { CalendarSyncProviderError } from "./adapter.js";
import { GRAPH_API_ROOT, type GraphCalendarHttp } from "./adapters/graph/graphCalendarHttp.js";
import { acceptCalendarPushNotification, type CalendarPushNotificationOutcome } from "./calendarPushNotifications.js";

const SUBSCRIPTIONS_URL = `${GRAPH_API_ROOT}/subscriptions`;
const WATCHED_RESOURCE = "/me/events";
/** Graph's longest lifetime for Outlook resources that every tenant accepts (about 2.94 days). */
const MAX_EXPIRATION_MINUTES = 4230;

const subscriptionSchema = z.object({
  id: z.string().min(1).max(256),
  expirationDateTime: z.iso.datetime({ offset: true }),
});

function expirationDateTime(): string {
  return new Date(Date.now() + MAX_EXPIRATION_MINUTES * 60_000).toISOString();
}

function subscriptionOf(json: unknown): { subscriptionId: string; expiresAt: Date } {
  const parsed = subscriptionSchema.safeParse(json);
  if (!parsed.success) {
    throw new CalendarSyncProviderError("invalidResponse", "Microsoft Graph sent an unusable subscription");
  }
  return { subscriptionId: parsed.data.id, expiresAt: new Date(parsed.data.expirationDateTime) };
}

export interface GraphCalendarSubscription {
  subscriptionId: string;
  clientState: string;
  expiresAt: Date;
}

/** Created, updated and deleted Events, with a fresh random `clientState`. */
export async function createGraphCalendarSubscription(
  http: GraphCalendarHttp,
  notificationUrl: string,
  signal: AbortSignal,
): Promise<GraphCalendarSubscription> {
  const clientState = randomBytes(32).toString("hex");
  const { json } = await http.send(
    {
      method: "POST",
      url: SUBSCRIPTIONS_URL,
      body: {
        changeType: "created,updated,deleted",
        notificationUrl,
        resource: WATCHED_RESOURCE,
        expirationDateTime: expirationDateTime(),
        clientState,
      },
    },
    signal,
  );
  return { ...subscriptionOf(json), clientState };
}

/** The new expiry, or `null` when Graph no longer has the subscription (404). `clientState` cannot change. */
export async function renewGraphCalendarSubscription(
  http: GraphCalendarHttp,
  subscriptionId: string,
  signal: AbortSignal,
): Promise<Date | null> {
  const { status, json } = await http.send(
    {
      method: "PATCH",
      url: `${SUBSCRIPTIONS_URL}/${encodeURIComponent(subscriptionId)}`,
      body: { expirationDateTime: expirationDateTime() },
      tolerate: [404],
    },
    signal,
  );
  return status === 404 ? null : subscriptionOf(json).expiresAt;
}

/** A subscription Graph no longer has (404) counts as deleted. */
export async function deleteGraphCalendarSubscription(
  http: GraphCalendarHttp,
  subscriptionId: string,
  signal: AbortSignal,
): Promise<void> {
  await http.send(
    { method: "DELETE", url: `${SUBSCRIPTIONS_URL}/${encodeURIComponent(subscriptionId)}`, tolerate: [404] },
    signal,
  );
}

export interface GraphCalendarNotification {
  subscriptionId: string;
  /** Absent is a rejection: Graph always sends the subscription's `clientState` back. */
  clientState: string | null;
}

export function handleGraphCalendarNotification(
  pool: Pool,
  notification: GraphCalendarNotification,
): Promise<CalendarPushNotificationOutcome> {
  return acceptCalendarPushNotification(pool, {
    provider: "graph",
    channelId: notification.subscriptionId,
    secret: notification.clientState,
  });
}
