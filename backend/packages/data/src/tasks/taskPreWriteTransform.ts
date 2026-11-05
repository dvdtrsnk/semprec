import { DateTime } from "luxon";
import type {
  ItemPreWritePreparation,
  ItemPreWriteTransform,
  ItemPreWriteTransformContext,
} from "../chokePoint/hooks.js";
import type { ItemRow } from "../types.js";
import { ValidationError } from "../errors.js";
import { assertValidTimezone, normalizeWallClockTime } from "../timezone.js";
import { getSystemTimezone } from "../systemSettings.js";
import { deriveTaskTime } from "./deriveTaskTime.js";
import { taskSinceRule } from "./taskSinceRule.js";

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Tasks pre-write transform, registered by `../domainWriteHooks.ts` under `TASKS_MODULE_ID`. It judges the
 * resulting state of a create or a patch (stored values merged with the patch) and returns the properties to
 * store: normalized `date`, `timeFrom` and `timeTo`, the derived `time`, and the `name` checked as non-blank.
 * See docs/adr/2026-10-29-item-pre-write-transforms-per-module-registry.md and
 * docs/adr/2026-10-29-tasks-date-and-time-rules-in-pre-write-transform.md.
 *
 * Schedule validation runs only when its input keys are named, so a status-only write does not revalidate a
 * legacy schedule. Completion and first-planned-day rules run separately in the managed write.
 */
export const prepareTaskWrite = async ({
  stored,
  patch,
}: Pick<ItemPreWriteTransformContext, "stored" | "patch">): Promise<Record<string, unknown>> => {
  const creating = stored === null;
  const nameNamed = patch.name !== undefined;
  const timeNamed = patch.date !== undefined || patch.timeFrom !== undefined || patch.timeTo !== undefined;
  if (!creating && !nameNamed && !timeNamed) return patch;
  if (nameNamed) assertNonBlankName(patch.name);
  if (!creating && !timeNamed) return patch;
  return deriveTimeAndCheckSchedule(stored, patch);
};

export const prepareTaskProposal: ItemPreWritePreparation = async ({ stored, patch }) => {
  let prepared = await prepareTaskWrite({ stored, patch });
  const oldStatus = stored?.properties.status;
  const status = Object.hasOwn(patch, "status") ? patch.status : oldStatus;
  const enteringDone = status === "done" && oldStatus !== "done";
  const leavingDone =
    stored !== null &&
    Object.hasOwn(patch, "status") &&
    status !== oldStatus &&
    (status === "notDone" || status === "wontDo");
  if (leavingDone && !Object.hasOwn(patch, "completedOn")) prepared = { ...prepared, completedOn: null };
  return { patch: prepared, deferredKeys: enteringDone && !Object.hasOwn(patch, "completedOn") ? ["completedOn"] : [] };
};

export const taskPreWriteTransform: ItemPreWriteTransform = async (context) => {
  const { stored, patch, client } = context;
  let output = await prepareTaskWrite({ stored, patch });
  const old = stored?.properties ?? {};
  const status = Object.hasOwn(patch, "status") ? patch.status : old.status;
  const enteringDone = status === "done" && old.status !== "done";
  const leavingDone =
    stored !== null &&
    Object.hasOwn(patch, "status") &&
    status !== old.status &&
    (status === "notDone" || status === "wontDo");
  const needsDay =
    enteringDone || Object.hasOwn(patch, "completedOn") || (stored !== null && Object.hasOwn(patch, "date"));
  if (!needsDay && !leavingDone) return output;
  const now = DateTime.utc();
  let today = "";
  if (needsDay) {
    const zone = await getSystemTimezone(client);
    assertValidTimezone(zone);
    today = now.setZone(zone).toFormat("yyyy-MM-dd");
  }
  if (Object.hasOwn(patch, "completedOn") && patch.completedOn != null) {
    const value = patch.completedOn;
    if (
      typeof value !== "string" ||
      !CALENDAR_DATE_PATTERN.test(value) ||
      !DateTime.fromISO(value, { zone: "utc" }).isValid ||
      value > today ||
      status !== "done"
    ) {
      throw new ValidationError("Property 'completedOn' must be a nonfuture completion day of a done task", {
        field: "completedOn",
      });
    }
  }
  if (enteringDone) {
    if (Object.hasOwn(patch, "completedOn") && patch.completedOn == null)
      throw new ValidationError("Property 'completedOn' must be a completion day", { field: "completedOn" });
    output = {
      ...output,
      completedOn: Object.hasOwn(patch, "completedOn") ? patch.completedOn : today,
      completedAt: now.toISO(),
    };
  } else if (leavingDone) {
    output = { ...output, completedOn: null, completedAt: null };
  }
  if (stored && Object.hasOwn(patch, "date")) output = { ...output, ...taskSinceRule(old, output, today) };
  return output;
};

function assertNonBlankName(value: unknown): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError("Property 'name' must be a non-empty title", { field: "name" });
  }
}

/** `""` and `null` switch the date off; any other value must be a real calendar date. `2026-02-30` is refused. */
function normalizeCalendarDate(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (
    typeof value === "string" &&
    CALENDAR_DATE_PATTERN.test(value) &&
    DateTime.fromISO(value, { zone: "utc" }).isValid
  ) {
    return value;
  }
  throw new ValidationError("Property 'date' must be a calendar date YYYY-MM-DD", { field: "date" });
}

function deriveTimeAndCheckSchedule(stored: ItemRow | null, patch: Record<string, unknown>): Record<string, unknown> {
  const storedProperties = stored?.properties ?? {};
  const dateNamed = patch.date !== undefined;
  const date = normalizeCalendarDate(dateNamed ? patch.date : (storedProperties.date ?? null));
  const namedFrom =
    patch.timeFrom === undefined ? undefined : normalizeWallClockTime(patch.timeFrom, { field: "timeFrom" });
  const namedTo =
    patch.timeTo === undefined ? undefined : normalizeWallClockTime(patch.timeTo, { field: "timeTo", allow2400: true });

  const output: Record<string, unknown> = { ...patch };
  if (dateNamed) output.date = date;
  if (namedFrom !== undefined) output.timeFrom = namedFrom;
  if (namedTo !== undefined) output.timeTo = namedTo;

  if (date === null) {
    // A start or end time needs a date. A date switched off here clears the stored times in the same write.
    if (namedFrom) throw new ValidationError("Property 'timeFrom' requires a date", { field: "timeFrom" });
    if (namedTo) throw new ValidationError("Property 'timeTo' requires a date", { field: "timeTo" });
    output.timeFrom = null;
    output.timeTo = null;
    output.time = null;
    return output;
  }

  const timeFrom =
    namedFrom !== undefined
      ? namedFrom
      : normalizeWallClockTime(storedProperties.timeFrom ?? null, { field: "timeFrom" });
  const timeTo =
    namedTo !== undefined
      ? namedTo
      : normalizeWallClockTime(storedProperties.timeTo ?? null, { field: "timeTo", allow2400: true });
  if (
    namedFrom === undefined &&
    Object.hasOwn(storedProperties, "timeFrom") &&
    storedProperties.timeFrom !== timeFrom
  ) {
    output.timeFrom = timeFrom;
  }
  if (namedTo === undefined && Object.hasOwn(storedProperties, "timeTo") && storedProperties.timeTo !== timeTo) {
    output.timeTo = timeTo;
  }
  if (timeTo !== null && timeFrom === null) {
    throw new ValidationError("Property 'timeTo' requires a 'timeFrom'", { field: "timeTo" });
  }
  // Both values are zero-padded HH:MM, so the string order is the clock order; `24:00` sorts after every other time.
  if (timeFrom !== null && timeTo !== null && timeTo <= timeFrom) {
    throw new ValidationError("Property 'timeTo' must be later than 'timeFrom'", { field: "timeTo" });
  }
  output.time = deriveTaskTime(timeFrom, timeTo);
  return output;
}
