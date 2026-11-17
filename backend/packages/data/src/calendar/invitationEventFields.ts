// The Events properties an invitation stands for. Answering an invitation writes them into a new Event and an
// organizer's update compares them with the Event, so both share this mapping.
import { z } from "zod";
import { instantToWallClock } from "../calendarTime.js";
import type { ItemRow } from "../types.js";

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
 * Times become wall clock in `timeZone` (the tenant's zone); all-day days are stored as midnight UTC. Without an
 * end the Events pre-write transform supplies `timeTo`. Pure over `invitation.properties`, so an organizer's
 * not-yet-stored update maps the same way.
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
      // A zero-length meeting (several clients send them) counts as no end, since `timeTo` equal to `timeFrom`
      // would be refused. An end before the start stays refused by the Events rules.
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
