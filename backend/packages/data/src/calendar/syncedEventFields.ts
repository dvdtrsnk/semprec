// The provider fields of a synced Event: its own zone, a raw RRULE with its exceptions, and the original start an
// override replaces. The calendar sync writes them; the calendar module derives two writes of its own (clearing the
// raw rule when the user edits `recurrence`, and copying zone and original start onto an override it materializes).
import { AsyncLocalStorage } from "node:async_hooks";
import { DateTime, IANAZone } from "luxon";
import { instantToWallClock, wallClockToInstant } from "../calendarTime.js";
import { z } from "zod";
import type {
  ItemCreateHook,
  ItemPreWritePreparation,
  ItemPreWriteTransform,
  ItemUpdateHook,
} from "../chokePoint/hooks.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { ForbiddenError, ValidationError } from "../errors.js";
import { EVENTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { DatabaseRow } from "../types.js";
import { EVENT_SERIES_ID_PROPERTY_KEY } from "./eventOccurrenceId.js";
import { EVENT_RECURRENCE_PROPERTY_KEY } from "./eventRecurrenceRule.js";
import { readTime } from "./eventTime.js";
import {
  EVENT_EXCEPTION_DATES_PROPERTY_KEY,
  EVENT_RECURRENCE_ID_PROPERTY_KEY,
  EVENT_RECURRENCE_RULE_PROPERTY_KEY,
  EVENT_TIME_ZONE_PROPERTY_KEY,
} from "./syncedEventKeys.js";
import { isCalendarDate } from "./eventValidationHook.js";
import { shiftDays } from "./recurrenceExpansion.js";
import type { Schedule } from "./timelineRead.js";

export {
  EVENT_EXCEPTION_DATES_PROPERTY_KEY,
  EVENT_RECURRENCE_ID_PROPERTY_KEY,
  EVENT_RECURRENCE_RULE_PROPERTY_KEY,
  EVENT_TIME_ZONE_PROPERTY_KEY,
};

export const SYNCED_EVENT_PROPERTY_KEYS = [
  EVENT_TIME_ZONE_PROPERTY_KEY,
  EVENT_RECURRENCE_RULE_PROPERTY_KEY,
  EVENT_EXCEPTION_DATES_PROPERTY_KEY,
  EVENT_RECURRENCE_ID_PROPERTY_KEY,
] as const;

/** The keys an override materialized by the calendar module carries besides `seriesId` and `occurrenceDate`. */
export const OVERRIDE_PROPERTY_KEYS = [EVENT_TIME_ZONE_PROPERTY_KEY, EVENT_RECURRENCE_ID_PROPERTY_KEY] as const;

const MAX_RULE_LENGTH = 2000;
const MAX_EXCEPTION_DATES = 1000;

/** A day, or a day and an `HH:MM` start, in the Event's zone. */
export type LocalStart = string;

function isLocalStart(value: unknown): value is LocalStart {
  if (typeof value !== "string") return false;
  const [date, time, ...rest] = value.split("T");
  if (rest.length > 0 || !isCalendarDate(date)) return false;
  if (time === undefined) return true;
  return /^\d{2}:\d{2}$/.test(time) && readTime(time, "timeFrom") === time;
}

const exceptionDatesSchema = z.array(z.string()).max(MAX_EXCEPTION_DATES);

/** `null` for a value that is no list of local starts. */
export function readExceptionDates(value: unknown): LocalStart[] | null {
  const parsed = exceptionDatesSchema.safeParse(value);
  if (!parsed.success || !parsed.data.every(isLocalStart)) return null;
  return parsed.data;
}

/** `null` for no zone (the tenant's); `undefined` for a value that is no IANA zone name. */
export function readEventTimeZone(properties: Record<string, unknown>): string | null | undefined {
  const value = properties[EVENT_TIME_ZONE_PROPERTY_KEY];
  if (value === undefined || value === null) return null;
  // `IANAZone` takes only a zone name: luxon's own parser would also take `system` and fixed offsets.
  return typeof value === "string" && IANAZone.isValidZone(value) ? value : undefined;
}

function daysFrom(from: string, to: string): number {
  return Math.round(DateTime.fromISO(to, { zone: "utc" }).diff(DateTime.fromISO(from, { zone: "utc" }), "days").days);
}

/**
 * An Event's wall-clock schedule in `eventZone` (`null`: the tenant's) as the tenant's wall clock. An all-day
 * schedule names days, not instants, and is not moved. A timed end that lands on the tenant's midnight is `24:00` of
 * the day before; without `timeTo`, `endDate` moves by as many days as the start did.
 */
export function scheduleInTenantZone(schedule: Schedule, eventZone: string | null, tenantZone: string): Schedule {
  if (eventZone === null || eventZone === tenantZone || schedule.timeFrom === null) return schedule;
  const start = instantToWallClock(
    wallClockToInstant(schedule.date, schedule.timeFrom, eventZone).toJSDate(),
    tenantZone,
  );
  if (schedule.timeTo === null) {
    const moved = daysFrom(schedule.date, start.date);
    return {
      date: start.date,
      endDate: schedule.endDate === null ? null : shiftDays(schedule.endDate, moved),
      timeFrom: start.time,
      timeTo: null,
    };
  }
  const endInstant = wallClockToInstant(schedule.endDate ?? schedule.date, schedule.timeTo, eventZone);
  const end = instantToWallClock(endInstant.toJSDate(), tenantZone);
  const closesDay = end.time === "00:00" && end.date > start.date;
  const lastDay = closesDay ? shiftDays(end.date, -1) : end.date;
  return {
    date: start.date,
    endDate: lastDay > start.date ? lastDay : null,
    timeFrom: start.time,
    timeTo: closesDay ? "24:00" : end.time,
  };
}

/**
 * Whether an entry of `exceptionDates`, or an override's `recurrenceId`, names the occurrence that starts at
 * `start` in the series' zone: a day names that day's occurrence, a date-time the occurrence starting then.
 */
export function namesLocalStart(entry: LocalStart, start: { date: string; time: string }, allDay: boolean): boolean {
  if (!entry.includes("T")) return entry === start.date;
  return !allDay && entry === `${start.date}T${start.time}`;
}

/** What an override materialized for the occurrence at `start` stores as `recurrenceId`. */
export function formatLocalStart(start: { date: string; time: string | null }): LocalStart {
  return start.time === null ? start.date : `${start.date}T${start.time}`;
}

function assertValue(key: (typeof SYNCED_EVENT_PROPERTY_KEYS)[number], value: unknown): void {
  if (value === null) return;
  const valid =
    key === EVENT_TIME_ZONE_PROPERTY_KEY
      ? readEventTimeZone({ [key]: value }) !== undefined
      : key === EVENT_RECURRENCE_RULE_PROPERTY_KEY
        ? typeof value === "string" && value.trim() !== "" && value.length <= MAX_RULE_LENGTH
        : key === EVENT_EXCEPTION_DATES_PROPERTY_KEY
          ? readExceptionDates(value) !== null
          : isLocalStart(value);
  if (valid) return;
  const expected =
    key === EVENT_TIME_ZONE_PROPERTY_KEY
      ? "an IANA time zone name"
      : key === EVENT_RECURRENCE_RULE_PROPERTY_KEY
        ? `RRULE text of at most ${MAX_RULE_LENGTH} characters`
        : key === EVENT_EXCEPTION_DATES_PROPERTY_KEY
          ? `a list of at most ${MAX_EXCEPTION_DATES} dates YYYY-MM-DD or date-times YYYY-MM-DDTHH:MM`
          : "a date YYYY-MM-DD or a date-time YYYY-MM-DDTHH:MM";
  throw new ValidationError(`Property '${key}' must be ${expected}`, { field: key });
}

/** The written row: a raw rule belongs to a series row, an original start to an override of one. */
function assertRowShape(properties: Record<string, unknown>): void {
  const has = (key: string): boolean => properties[key] !== undefined && properties[key] !== null;
  if (has(EVENT_RECURRENCE_RULE_PROPERTY_KEY) && has(EVENT_RECURRENCE_PROPERTY_KEY)) {
    throw new ValidationError("An Event carries either 'recurrence' or 'recurrenceRule', not both", {
      field: EVENT_RECURRENCE_RULE_PROPERTY_KEY,
    });
  }
  if (has(EVENT_RECURRENCE_RULE_PROPERTY_KEY) && has(EVENT_SERIES_ID_PROPERTY_KEY)) {
    throw new ValidationError("An occurrence of a series cannot carry 'recurrenceRule'", {
      field: EVENT_RECURRENCE_RULE_PROPERTY_KEY,
    });
  }
  if (has(EVENT_RECURRENCE_ID_PROPERTY_KEY) && !has(EVENT_SERIES_ID_PROPERTY_KEY)) {
    throw new ValidationError("'recurrenceId' belongs to an occurrence of a series", {
      field: EVENT_RECURRENCE_ID_PROPERTY_KEY,
    });
  }
}

const overrideScope = new AsyncLocalStorage<true>();

/** Runs `fn` as the calendar module's materialization of an override, which may copy `OVERRIDE_PROPERTY_KEYS`. */
export function withOverrideMaterialization<T>(fn: () => Promise<T>): Promise<T> {
  return overrideScope.run(true, fn);
}

function isCalendarSync(writer: WriterIdentity): boolean {
  return writer.writerKind === "system" && writer.systemProcess === "calendarSync";
}

function ownerViolation(key: string): ForbiddenError {
  return new ForbiddenError(
    `Property '${key}' is written only by the calendar sync`,
    { field: key },
    "owner_violation",
  );
}

function isEventsDatabase(database: DatabaseRow): boolean {
  return database.system && database.ownerModuleId === EVENTS_MODULE_ID;
}

function namedKeys(values: Record<string, unknown>): (typeof SYNCED_EVENT_PROPERTY_KEYS)[number][] {
  return SYNCED_EVENT_PROPERTY_KEYS.filter((key) => Object.hasOwn(values, key));
}

/**
 * Only the calendar sync names the provider fields on a create, except the zone and original start an override
 * materialization copies. Values are judged for every writer.
 */
export const syncedEventItemCreateHook: ItemCreateHook = async ({ database, properties, writer }) => {
  if (!isEventsDatabase(database)) return;
  const keys = namedKeys(properties).filter((key) => properties[key] !== null);
  if (keys.length === 0) return;
  if (!isCalendarSync(writer)) {
    const materializing = overrideScope.getStore() === true;
    const refused = keys.find((key) => !materializing || !(OVERRIDE_PROPERTY_KEYS as readonly string[]).includes(key));
    if (refused !== undefined) throw ownerViolation(refused);
  }
  for (const key of keys) assertValue(key, properties[key]);
  assertRowShape(properties);
};

/**
 * Only the calendar sync names the provider fields on an update, except the raw rule and its exceptions cleared
 * together with a `recurrence` edit (`syncedRecurrenceTransform`).
 */
export const syncedEventItemUpdateHook: ItemUpdateHook = async ({ database, item, propertiesPatch, writer }) => {
  if (!isEventsDatabase(database)) return;
  const keys = namedKeys(propertiesPatch);
  if (keys.length === 0) return;
  if (!isCalendarSync(writer)) {
    const clearsRule = Object.hasOwn(propertiesPatch, EVENT_RECURRENCE_PROPERTY_KEY);
    const refused = keys.find(
      (key) =>
        !clearsRule ||
        propertiesPatch[key] !== null ||
        (key !== EVENT_RECURRENCE_RULE_PROPERTY_KEY && key !== EVENT_EXCEPTION_DATES_PROPERTY_KEY),
    );
    if (refused !== undefined) throw ownerViolation(refused);
  }
  for (const key of keys) assertValue(key, propertiesPatch[key]);
  assertRowShape(item.properties);
};

function hasRawRule(properties: Record<string, unknown> | undefined): boolean {
  const rule = properties?.[EVENT_RECURRENCE_RULE_PROPERTY_KEY];
  return rule !== undefined && rule !== null;
}

/**
 * A `recurrence` edit of a series that carries a raw rule replaces that rule: the raw rule and its exceptions are
 * cleared, and the sync serializes the simple rule. Edits that leave `recurrence` alone keep the raw rule.
 */
function clearRawRule(
  stored: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.hasOwn(patch, EVENT_RECURRENCE_PROPERTY_KEY) || !hasRawRule(stored)) return patch;
  if (Object.hasOwn(patch, EVENT_RECURRENCE_RULE_PROPERTY_KEY)) return patch;
  return { ...patch, [EVENT_RECURRENCE_RULE_PROPERTY_KEY]: null, [EVENT_EXCEPTION_DATES_PROPERTY_KEY]: null };
}

export const syncedRecurrenceTransform: ItemPreWriteTransform = async ({ stored, patch }) =>
  clearRawRule(stored?.properties, patch);

export const prepareSyncedRecurrence: ItemPreWritePreparation = async ({ stored, patch }) => ({
  patch: clearRawRule(stored?.properties, patch),
  deferredKeys: [],
});
