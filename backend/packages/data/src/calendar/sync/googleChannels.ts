// Google Calendar push channels: `events.watch` on one calendar, `channels.stop`, and the webhook's notification.
// A channel cannot be extended; it is replaced by a new one before it expires.
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { CalendarSyncProviderError } from "./adapter.js";
import { GoogleCalendarHttp, parseGoogleBody } from "./adapters/google/googleCalendarHttp.js";
import { acceptCalendarPushNotification, type CalendarPushNotificationOutcome } from "./calendarPushNotifications.js";

/** Asked for; Google may grant less and says so in the answer's `expiration`. */
const GOOGLE_CHANNEL_TTL_SECONDS = 7 * 24 * 60 * 60;

const watchAnswerSchema = z.object({
  id: z.string(),
  resourceId: z.string().min(1).max(2048),
  /** Milliseconds since the epoch, as a string. */
  expiration: z.string().regex(/^\d{1,16}$/),
});

export interface GoogleChannel {
  channelId: string;
  token: string;
  resourceId: string;
  expiresAt: Date;
}

/** Watches the Events of one calendar, with a fresh channel id and a fresh random token. */
export async function watchGoogleCalendar(
  http: GoogleCalendarHttp,
  remoteCalendarId: string,
  notificationUrl: string,
  signal: AbortSignal,
): Promise<GoogleChannel> {
  const channelId = randomUUID();
  const token = randomBytes(32).toString("hex");
  const { body } = await http.request(
    {
      method: "POST",
      path: `/calendars/${encodeURIComponent(remoteCalendarId)}/events/watch`,
      body: {
        id: channelId,
        type: "web_hook",
        address: notificationUrl,
        token,
        params: { ttl: String(GOOGLE_CHANNEL_TTL_SECONDS) },
      },
    },
    signal,
  );
  const answer = parseGoogleBody(watchAnswerSchema, body);
  if (answer.id !== channelId) {
    throw new CalendarSyncProviderError("invalidResponse", "Google answered a watch with another channel id");
  }
  return { channelId, token, resourceId: answer.resourceId, expiresAt: new Date(Number(answer.expiration)) };
}

/** A channel Google no longer knows (404) counts as stopped. */
export async function stopGoogleChannel(
  http: GoogleCalendarHttp,
  channel: { channelId: string; resourceId: string },
  signal: AbortSignal,
): Promise<void> {
  await http.request(
    { method: "POST", path: "/channels/stop", body: { id: channel.channelId, resourceId: channel.resourceId } },
    signal,
    [404],
  );
}

/** Google's notification headers; the body is empty and unread. */
export interface GoogleCalendarNotification {
  channelId: string;
  token: string | null;
  /** `sync` right after the channel was created, then `exists` or `not_exists` per change. */
  resourceState: string | null;
}

/** A valid `sync` message is accepted without queueing a pass: it announces the channel, not a change. */
export function handleGoogleCalendarNotification(
  pool: Pool,
  notification: GoogleCalendarNotification,
): Promise<CalendarPushNotificationOutcome> {
  return acceptCalendarPushNotification(pool, {
    provider: "google",
    channelId: notification.channelId,
    secret: notification.token,
    enqueue: notification.resourceState !== "sync",
  });
}
