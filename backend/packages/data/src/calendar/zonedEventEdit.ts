// A user or agent edits an Event's times as the tenant's wall clock, the way every client shows them. An Event with a
// zone of its own (a synced one) stores its times in that zone, so an edit is converted there before it is stored:
// the Event keeps its zone, and the times not edited keep their instant.
import type { ItemPreWritePreparation, ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { getSystemTimezone } from "../systemSettings.js";
import { deriveTaskTime } from "../tasks/deriveTaskTime.js";
import { assertValidTimezone } from "../timezone.js";
import { readTime } from "./eventTime.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { readEventTimeZone, scheduleInTenantZone } from "./syncedEventFields.js";
import type { Schedule } from "./timelineRead.js";

const SCHEDULE_KEYS = ["date", "endDate", "timeFrom", "timeTo"] as const;

/** `undefined` when a value is unreadable; the Events validation then refuses it. */
function readSchedule(properties: Record<string, unknown>): Schedule | undefined {
  const { date, endDate } = properties;
  if (!isCalendarDate(date)) return undefined;
  if (endDate !== undefined && endDate !== null && !isCalendarDate(endDate)) return undefined;
  const timeFrom = readTime(properties.timeFrom ?? null, "timeFrom");
  const timeTo = readTime(properties.timeTo ?? null, "timeTo");
  if (timeFrom === undefined || timeTo === undefined) return undefined;
  return { date, endDate: typeof endDate === "string" ? endDate : null, timeFrom, timeTo };
}

/**
 * Runs after the Events time transform, on its normalized patch. Only a user's or agent's update of a timed Event
 * whose zone differs from the tenant's is converted: the stored times are shown in the tenant's zone, the patched
 * ones laid over them, and the result converted back. An all-day result names days, which are not moved. The
 * calendar sync and other system writers store their values as sent.
 */
export const zonedEventEditTransform: ItemPreWriteTransform = async ({ client, stored, patch, writer }) => {
  if (stored === null || (writer.writerKind !== "user" && writer.writerKind !== "agent")) return patch;
  if (!SCHEDULE_KEYS.some((key) => Object.hasOwn(patch, key))) return patch;
  const zone = readEventTimeZone(stored.properties);
  if (zone === null || zone === undefined) return patch;
  const tenantZone = await getSystemTimezone(client);
  assertValidTimezone(tenantZone);
  if (zone === tenantZone) return patch;
  const storedSchedule = readSchedule(stored.properties);
  if (storedSchedule === undefined) return patch;
  const edited = readSchedule({ ...scheduleInTenantZone(storedSchedule, zone, tenantZone), ...pickSchedule(patch) });
  if (edited === undefined || edited.timeFrom === null) return patch;
  const converted = scheduleInTenantZone(edited, tenantZone, zone);
  const output: Record<string, unknown> = { ...patch };
  for (const key of SCHEDULE_KEYS) {
    if (Object.hasOwn(patch, key) || converted[key] !== (storedSchedule[key] ?? null)) output[key] = converted[key];
  }
  output.time = deriveTaskTime(converted.timeFrom, converted.timeTo);
  return output;
};

function pickSchedule(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(SCHEDULE_KEYS.filter((key) => Object.hasOwn(patch, key)).map((key) => [key, patch[key]]));
}

/**
 * A prepared proposal keeps the tenant's wall clock it was made in; the write that executes it converts it, against
 * the Event as stored then.
 */
export const prepareZonedEventEdit: ItemPreWritePreparation = async ({ patch }) => ({ patch, deferredKeys: [] });
