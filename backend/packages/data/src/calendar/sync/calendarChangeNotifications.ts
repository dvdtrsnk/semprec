// The notifications a calendar sync pass writes about provider changes in account calendars whose `notify` is on:
// one per added, changed or cancelled Event, or one summary per calendar when a pass brings more than
// `SUMMARY_THRESHOLD` of them.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { getTenantUserId } from "../../auth/usersStore.js";
import { normalizeEmailAddress } from "../../mail/personEmailIndexStore.js";
import { writeNotification } from "../../notifications/notify.js";
import { logger } from "../logger.js";

/** A pass with more changes than this in one calendar writes one summary instead. */
const SUMMARY_THRESHOLD = 3;
const EVENT_NAME_MAX_CHARACTERS = 120;

/** The Event fields whose provider change is news: its title, time and place. */
export const NOTIFIED_EVENT_FIELD_KEYS = [
  "name",
  "date",
  "endDate",
  "timeFrom",
  "timeTo",
  "timeZone",
  "place",
] as const;

export type CalendarChangeKind = "added" | "changed" | "cancelled";

const KIND_OF_CHANGE = {
  added: "calendar_event_added",
  changed: "calendar_event_changed",
  cancelled: "calendar_event_cancelled",
} as const;

/** The part of an Event's `base_snapshot` the copy uses. */
const snapshotSchema = z.object({
  fields: z.object({
    name: z.string().nullable(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    timeFrom: z.string().nullable(),
  }),
  organizer: z.object({ email: z.string().nullable(), name: z.string().nullable() }).nullable(),
});

export interface CalendarChangeNotice {
  kind: CalendarChangeKind;
  eventItemId: string;
  calendarItemId: string;
  /** The provider's version of the Event: the fetched one, or for a cancellation the last applied one. */
  snapshot: Record<string, unknown>;
  etag: string | null;
}

export interface NotifiedCalendar {
  calendarItemId: string;
  /** The calendar's own name, else the provider's. */
  name: string;
}

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Keys sorted at every level, so a snapshot read back from `jsonb` hashes like the one written. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Stable for a replay of the same provider version, distinct for each new one. */
function transitionInstanceOf(notice: CalendarChangeNotice): string {
  const version = notice.etag ?? createHash("sha256").update(canonicalJson(notice.snapshot)).digest("hex");
  return `${notice.kind}:${version}`;
}

/** The organizer's name, unless the organizer is one of the account's own addresses or has no name. */
function personOf(organizer: z.infer<typeof snapshotSchema>["organizer"], ownAddresses: ReadonlySet<string>) {
  const name = organizer?.name?.trim();
  if (!name) return null;
  if (organizer?.email && ownAddresses.has(normalizeEmailAddress(organizer.email))) return null;
  return name;
}

async function writeEventNotice(
  client: PoolClient,
  userId: string,
  calendar: NotifiedCalendar,
  notice: CalendarChangeNotice,
  ownAddresses: ReadonlySet<string>,
): Promise<void> {
  const { fields, organizer } = snapshotSchema.parse(notice.snapshot);
  const person = personOf(organizer, ownAddresses);
  const time = fields.timeFrom === null ? null : fields.timeFrom.slice(0, 5);
  const weekday = WEEKDAY_KEYS[new Date(`${fields.date}T00:00:00Z`).getUTCDay()];
  await writeNotification(client, {
    userId,
    kind: KIND_OF_CHANGE[notice.kind],
    titleParams: { calendar: calendar.name },
    bodyKey: `calendarChange.${notice.kind}.${time === null ? "allDay" : "timed"}${person === null ? "" : "ByPerson"}`,
    bodyParams: {
      event: fields.name === null ? null : Array.from(fields.name).slice(0, EVENT_NAME_MAX_CHARACTERS).join(""),
      ...(time === null ? {} : { time }),
      ...(person === null ? {} : { person: Array.from(person).slice(0, EVENT_NAME_MAX_CHARACTERS).join("") }),
    },
    bodyParamKeys: { day: `calendarChange.weekday.${weekday}` },
    linkHref: `?page=event&id=${notice.eventItemId}`,
    sourceTable: "items",
    sourceId: notice.eventItemId,
    transitionInstance: transitionInstanceOf(notice),
    payload: { eventId: notice.eventItemId, calendarId: notice.calendarItemId },
  });
}

/**
 * Runs in the apply's transaction, so the notifications commit or roll back with the changes they announce. A replay
 * of the same provider versions writes nothing new (`writeNotification`'s dedupe). `calendars` are the notify-on
 * calendars; notices of any other calendar are dropped.
 */
export async function notifyCalendarChanges(
  client: PoolClient,
  input: {
    accountItemId: string;
    calendars: readonly NotifiedCalendar[];
    /** The account's addresses; an organizer with one of them is the user, whom the copy does not name. */
    ownAddresses: readonly string[];
    notices: readonly CalendarChangeNotice[];
  },
): Promise<void> {
  const byCalendar = new Map(
    input.calendars.map((calendar) => [calendar.calendarItemId, [] as CalendarChangeNotice[]]),
  );
  for (const notice of input.notices) byCalendar.get(notice.calendarItemId)?.push(notice);
  if (![...byCalendar.values()].some((notices) => notices.length > 0)) return;
  const userId = await getTenantUserId(client);
  if (userId === null) {
    logger.warn({ accountItemId: input.accountItemId, reason: "no_tenant_user" }, "calendar changes not notified");
    return;
  }
  const ownAddresses = new Set(input.ownAddresses.map(normalizeEmailAddress));
  for (const calendar of input.calendars) {
    const notices = byCalendar.get(calendar.calendarItemId) ?? [];
    if (notices.length <= SUMMARY_THRESHOLD) {
      for (const notice of notices) await writeEventNotice(client, userId, calendar, notice, ownAddresses);
      continue;
    }
    const members = notices.map((notice) => `${notice.eventItemId}:${transitionInstanceOf(notice)}`).sort();
    await writeNotification(client, {
      userId,
      kind: "calendar_event_changed",
      titleParams: { calendar: calendar.name },
      // The Czech plural of 2 to 4 differs from that of 5 and more; English has one form for both.
      bodyKey: `calendarChange.summary.${notices.length <= 4 ? "few" : "many"}`,
      bodyParams: { count: notices.length },
      linkHref: null,
      sourceTable: "items",
      sourceId: calendar.calendarItemId,
      transitionInstance: `summary:${createHash("sha256").update(members.join("\n")).digest("hex")}`,
      payload: { calendarId: calendar.calendarItemId, count: notices.length },
    });
  }
}
