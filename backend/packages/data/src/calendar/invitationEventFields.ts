// The Events properties an invitation stands for (issues gh-1944 and gh-2007). The answer to an invitation writes them
// into a new Event, and an organizer's update compares them with what the Event holds, so both read the same mapping.
import { z } from "zod";
import { instantToWallClock } from "../calendarTime.js";
import type { ItemRow } from "../types.js";

/** The stored fields an Event is made from. `startsAt` and `endsAt` are ISO UTC instants, as the ingest stores them. */
const eventSourceSchema = z.object({
  title: z.string().nullish(),
  place: z.string().nullish(),
  allDay: z.boolean().nullish(),
  startsAt: z.string(),
  endsAt: z.string().nullish(),
});

function readInstant(invitationId: string, field: string, value: string): Date {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new Error(`Invitation ${invitationId} has an unreadable '${field}'`);
  return instant;
}

/**
 * The Events properties of an invitation: its title (as `name`) and place, `type` `meeting`, and its times as wall
 * clock in `timeZone`, the tenant's zone. An all-day invitation has no `timeFrom`, its `date` is the first day and
 * `endDate` the last day when that is another day; the ingest stores both days as midnight UTC. A timed one takes `date`
 * and `timeFrom` from its start and, when it has an end, `timeTo` from it, with `endDate` when the end is on another
 * day. Without an end, or with an end that is the start's own minute, the Events pre-write transform supplies `timeTo`.
 * A title or place the invitation does not carry is a key left out.
 *
 * Pure: it reads `invitation.properties` only, so the properties an organizer's update is about to store can be mapped
 * the same way as the stored ones. An invitation with no `startsAt` text throws a plain `Error` naming the invitation,
 * and one whose `startsAt` or `endsAt` is no instant throws a plain `Error` naming the invitation and the field.
 */
export function invitationEventFields(
  invitation: Pick<ItemRow, "id" | "properties">,
  timeZone: string,
): Record<string, unknown> {
  const source = eventSourceSchema.safeParse(invitation.properties);
  if (!source.success) throw new Error(`Invitation ${invitation.id} has no readable start`);
  const { title, place, allDay, startsAt, endsAt } = source.data;
  const start = readInstant(invitation.id, "startsAt", startsAt);
  const end = endsAt == null ? null : readInstant(invitation.id, "endsAt", endsAt);
  const times: Record<string, unknown> = {};
  if (allDay === true) {
    times.date = start.toISOString().slice(0, 10);
    const lastDay = end?.toISOString().slice(0, 10);
    if (lastDay !== undefined && lastDay !== times.date) times.endDate = lastDay;
  } else {
    const from = instantToWallClock(start, timeZone);
    times.date = from.date;
    times.timeFrom = from.time;
    if (end !== null) {
      const to = instantToWallClock(end, timeZone);
      // An end that reads as the start's own minute (a zero-length meeting, which several calendar clients send) is
      // no end: `timeTo` equal to `timeFrom` would be refused, so the Events default end applies. An end before the
      // start is a malformed invitation and stays refused by the Events rules.
      const zeroLength = end.getTime() >= start.getTime() && to.date === from.date && to.time === from.time;
      if (!zeroLength) {
        times.timeTo = to.time;
        if (to.date !== from.date) times.endDate = to.date;
      }
    }
  }
  return {
    ...(title == null ? {} : { name: title }),
    ...(place == null ? {} : { place }),
    type: "meeting",
    ...times,
  };
}
