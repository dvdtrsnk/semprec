import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors.js";
import { computeNextFireAt } from "../scheduler/nextFireAt.js";
import {
  resolveSleepNights,
  type ResolveSleepNightsInput,
  type SleepNightException,
  type SleepPlan,
} from "../sleep/resolveSleepNights.js";

const TZ = "Europe/Prague";

const WEEKDAYS: SleepPlan = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Weekdays",
  wakeDays: ["mon", "tue", "wed", "thu", "fri"],
  bedTime: "23:00",
  wakeTime: "06:45",
  alarm: true,
  position: 0,
};
const WEEKEND: SleepPlan = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "Weekend",
  wakeDays: ["sat", "sun"],
  bedTime: "00:00",
  wakeTime: "08:30",
  alarm: false,
  position: 1,
};
const DEFAULT_PLANS = [WEEKDAYS, WEEKEND];

/** Resolves with the default settings (a reminder 30 minutes before bedtime), the default plans and no exception unless overridden. */
function resolve(overrides: Partial<ResolveSleepNightsInput> & { from: string; to?: string }) {
  return resolveSleepNights({
    settings: { prepReminder: true, prepReminderMinutes: 30 },
    plans: DEFAULT_PLANS,
    nights: [],
    timezone: TZ,
    ...overrides,
    to: overrides.to ?? overrides.from,
  });
}

function exception(night: string, fields: Partial<Omit<SleepNightException, "night">>): SleepNightException {
  return { night, bedTime: null, wakeTime: null, alarm: null, ...fields };
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw");
}

describe("resolveSleepNights (issue #1792)", () => {
  it("resolves the Friday night 2026-10-16 to the weekend plan with its instants, 510 minutes and the reminder", () => {
    expect(resolve({ from: "2026-10-16" })).toEqual([
      {
        night: "2026-10-16",
        planId: WEEKEND.id,
        planName: "Weekend",
        bedTime: "00:00",
        wakeTime: "08:30",
        alarm: false,
        changed: false,
        bedAt: "2026-10-17T00:00:00+02:00",
        wakeAt: "2026-10-17T08:30:00+02:00",
        durationMinutes: 510,
        prepReminderAt: "2026-10-16T23:30:00+02:00",
      },
    ]);
  });

  it("resolves the Thursday night 2026-10-15 to the weekday plan with 465 minutes and the alarm on", () => {
    expect(resolve({ from: "2026-10-15" })).toEqual([
      {
        night: "2026-10-15",
        planId: WEEKDAYS.id,
        planName: "Weekdays",
        bedTime: "23:00",
        wakeTime: "06:45",
        alarm: true,
        changed: false,
        bedAt: "2026-10-15T23:00:00+02:00",
        wakeAt: "2026-10-16T06:45:00+02:00",
        durationMinutes: 465,
        prepReminderAt: "2026-10-15T22:30:00+02:00",
      },
    ]);
  });

  it("returns every night of an inclusive range in ascending order, each with the plan of the following morning", () => {
    const nights = resolve({ from: "2026-10-12", to: "2026-10-18" });

    expect(nights.map((night) => [night.night, night.planName])).toEqual([
      ["2026-10-12", "Weekdays"],
      ["2026-10-13", "Weekdays"],
      ["2026-10-14", "Weekdays"],
      ["2026-10-15", "Weekdays"],
      ["2026-10-16", "Weekend"],
      ["2026-10-17", "Weekend"],
      // Sunday night: the morning is a Monday.
      ["2026-10-18", "Weekdays"],
    ]);
  });

  it("takes only the wake time from an exception that overrides only it, and marks the night changed", () => {
    const [night] = resolve({ from: "2026-10-16", nights: [exception("2026-10-16", { wakeTime: "07:30" })] });

    expect(night).toEqual({
      night: "2026-10-16",
      planId: WEEKEND.id,
      planName: "Weekend",
      bedTime: "00:00",
      wakeTime: "07:30",
      alarm: false,
      changed: true,
      bedAt: "2026-10-17T00:00:00+02:00",
      wakeAt: "2026-10-17T07:30:00+02:00",
      durationMinutes: 450,
      prepReminderAt: "2026-10-16T23:30:00+02:00",
    });
  });

  it("takes only the alarm from an exception that overrides only it, also when it switches the plan's alarm off", () => {
    const [on] = resolve({ from: "2026-10-16", nights: [exception("2026-10-16", { alarm: true })] });
    const [off] = resolve({ from: "2026-10-15", nights: [exception("2026-10-15", { alarm: false })] });

    expect(on).toMatchObject({ planId: WEEKEND.id, bedTime: "00:00", wakeTime: "08:30", alarm: true, changed: true });
    expect(off).toMatchObject({
      planId: WEEKDAYS.id,
      bedTime: "23:00",
      wakeTime: "06:45",
      alarm: false,
      changed: true,
    });
  });

  it("leaves a night as its plan gives it when the exception has every field null, and applies an exception only to its own night", () => {
    const withException = resolve({
      from: "2026-10-15",
      to: "2026-10-16",
      nights: [exception("2026-10-16", {}), exception("2026-10-30", { wakeTime: "05:00" })],
    });

    expect(withException).toEqual(resolve({ from: "2026-10-15", to: "2026-10-16" }));
    expect(withException.map((night) => night.changed)).toEqual([false, false]);
  });

  it("omits a night that has neither a plan nor an exception", () => {
    const nights = resolve({ from: "2026-10-14", to: "2026-10-17", plans: [WEEKEND] });

    expect(nights.map((night) => night.night)).toEqual(["2026-10-16", "2026-10-17"]);
  });

  it("omits a night without a plan whose exception has every field null, exactly as without the exception", () => {
    const reset = exception("2026-10-15", {});

    expect(resolve({ from: "2026-10-15", plans: [WEEKEND], nights: [reset] })).toEqual([]);
    // In a range, the nights around it are what they are without the exception.
    const nights = resolve({ from: "2026-10-14", to: "2026-10-17", plans: [WEEKEND], nights: [reset] });
    expect(nights.map((night) => night.night)).toEqual(["2026-10-16", "2026-10-17"]);
    expect(nights).toEqual(resolve({ from: "2026-10-14", to: "2026-10-17", plans: [WEEKEND] }));
  });

  it("gives a night without a plan whose exception overrides a field the base 23:00 to 07:00 without an alarm, overridden by the exception", () => {
    const nights = resolve({
      from: "2026-10-13",
      to: "2026-10-15",
      plans: [WEEKEND],
      nights: [
        exception("2026-10-13", { alarm: false }),
        exception("2026-10-14", { bedTime: "22:00" }),
        exception("2026-10-15", {}),
      ],
    });

    expect(nights).toEqual([
      // The override equals the base value; the night exists because the exception sets a field.
      {
        night: "2026-10-13",
        planId: null,
        planName: null,
        bedTime: "23:00",
        wakeTime: "07:00",
        alarm: false,
        changed: true,
        bedAt: "2026-10-13T23:00:00+02:00",
        wakeAt: "2026-10-14T07:00:00+02:00",
        durationMinutes: 480,
        prepReminderAt: "2026-10-13T22:30:00+02:00",
      },
      {
        night: "2026-10-14",
        planId: null,
        planName: null,
        bedTime: "22:00",
        wakeTime: "07:00",
        alarm: false,
        changed: true,
        bedAt: "2026-10-14T22:00:00+02:00",
        wakeAt: "2026-10-15T07:00:00+02:00",
        durationMinutes: 540,
        prepReminderAt: "2026-10-14T21:30:00+02:00",
      },
    ]);
  });

  it("keeps 510 minutes across the end of daylight saving on 2026-10-24 and renders the wake time with +01:00", () => {
    const [night] = resolve({ from: "2026-10-24" });

    expect(night).toMatchObject({
      night: "2026-10-24",
      planId: WEEKEND.id,
      bedAt: "2026-10-25T00:00:00+02:00",
      wakeAt: "2026-10-25T08:30:00+01:00",
      durationMinutes: 510,
    });
    // The night gained an hour: 570 minutes pass between the two instants.
    expect(Date.parse(night?.wakeAt ?? "") - Date.parse(night?.bedAt ?? "")).toBe(570 * 60_000);
  });

  it("keeps 510 minutes across the start of daylight saving on 2027-03-27 and renders the wake time with +02:00", () => {
    const [night] = resolve({ from: "2027-03-27" });

    expect(night).toMatchObject({
      night: "2027-03-27",
      planId: WEEKEND.id,
      bedAt: "2027-03-28T00:00:00+01:00",
      wakeAt: "2027-03-28T08:30:00+02:00",
      durationMinutes: 510,
    });
    expect(Date.parse(night?.wakeAt ?? "") - Date.parse(night?.bedAt ?? "")).toBe(450 * 60_000);
  });

  it("moves the wake time 02:30 that does not exist on 2027-03-28 forward, exactly as nextFireAt resolves it", () => {
    const [night] = resolve({ from: "2027-03-27", nights: [exception("2027-03-27", { wakeTime: "02:30" })] });
    // 00:30 local on 2027-03-28, before the clocks move from 02:00 to 03:00.
    const fire = computeNextFireAt({ kind: "dailyTime", at: "02:30" }, TZ, new Date("2027-03-27T23:30:00.000Z"));

    expect(night).toMatchObject({ wakeTime: "02:30", wakeAt: "2027-03-28T03:30:00+02:00", durationMinutes: 150 });
    expect(fire?.toISOString()).toBe("2027-03-28T01:30:00.000Z");
    expect(new Date(night?.wakeAt ?? "").toISOString()).toBe(fire?.toISOString());
  });

  it("takes the earlier occurrence of the wake time 02:30 that happens twice on 2026-10-25", () => {
    const [night] = resolve({ from: "2026-10-24", nights: [exception("2026-10-24", { wakeTime: "02:30" })] });

    expect(night).toMatchObject({ wakeAt: "2026-10-25T02:30:00+02:00", durationMinutes: 150 });
  });

  it("gives a day that two plans contain to the plan with the lower position", () => {
    const early: SleepPlan = { ...WEEKEND, id: "00000000-0000-4000-8000-00000000000f", name: "Early", position: 0 };
    const late: SleepPlan = { ...WEEKEND, id: "00000000-0000-4000-8000-00000000000a", name: "Late", position: 5 };

    for (const plans of [
      [early, late],
      [late, early],
    ]) {
      expect(resolve({ from: "2026-10-16", plans })).toMatchObject([{ planId: early.id, planName: "Early" }]);
    }
  });

  it("breaks a tie of positions by the lower id, whatever the order of the input, and leaves the input untouched", () => {
    const lower: SleepPlan = { ...WEEKEND, id: "00000000-0000-4000-8000-00000000000a", name: "Lower id", position: 3 };
    const higher: SleepPlan = {
      ...WEEKEND,
      id: "00000000-0000-4000-8000-00000000000b",
      name: "Higher id",
      position: 3,
    };

    for (const plans of [Object.freeze([lower, higher]), Object.freeze([higher, lower])]) {
      const before = [...plans];
      expect(resolve({ from: "2026-10-16", plans })).toMatchObject([{ planId: lower.id, planName: "Lower id" }]);
      expect(plans).toEqual(before);
    }
  });

  it("never matches a plan whose wakeDays are empty", () => {
    const empty: SleepPlan = { ...WEEKDAYS, wakeDays: [] };

    expect(resolve({ from: "2026-10-12", to: "2026-10-18", plans: [empty] })).toEqual([]);
  });

  it("puts a bedtime of 12:00 on the night's own day and a bedtime before 12:00 on the day after", () => {
    const noon: SleepPlan = { ...WEEKEND, bedTime: "12:00" };
    const beforeNoon: SleepPlan = { ...WEEKEND, bedTime: "11:59" };

    expect(resolve({ from: "2026-10-16", plans: [noon] })).toMatchObject([
      { bedAt: "2026-10-16T12:00:00+02:00", wakeAt: "2026-10-17T08:30:00+02:00", durationMinutes: 1230 },
    ]);
    // The wake time 08:30 is before the bedtime 11:59 of the same day, so the planned length is 0.
    expect(resolve({ from: "2026-10-16", plans: [beforeNoon] })).toMatchObject([
      { bedAt: "2026-10-17T11:59:00+02:00", wakeAt: "2026-10-17T08:30:00+02:00", durationMinutes: 0 },
    ]);
  });

  it("gives 0 minutes when the wake time equals a bedtime after midnight", () => {
    const same: SleepPlan = { ...WEEKEND, bedTime: "08:30" };

    expect(resolve({ from: "2026-10-16", plans: [same] })).toMatchObject([{ durationMinutes: 0 }]);
  });

  it("sets the reminder the given minutes before the bedtime, and no reminder when it is switched off", () => {
    const [lead] = resolve({ from: "2026-10-15", settings: { prepReminder: true, prepReminderMinutes: 45 } });
    const [off] = resolve({ from: "2026-10-15", settings: { prepReminder: false, prepReminderMinutes: 45 } });

    expect(lead?.prepReminderAt).toBe("2026-10-15T22:15:00+02:00");
    expect(off?.prepReminderAt).toBeNull();
    expect(off?.bedAt).toBe("2026-10-15T23:00:00+02:00");
  });

  it("reads the wall-clock times in the given zone, and renders offset zero as Z in the fixed zones UTC and GMT and as +00:00 in an IANA zone", () => {
    expect(resolve({ from: "2026-10-16", timezone: "America/New_York" })).toMatchObject([
      {
        bedAt: "2026-10-17T00:00:00-04:00",
        wakeAt: "2026-10-17T08:30:00-04:00",
        prepReminderAt: "2026-10-16T23:30:00-04:00",
      },
    ]);
    for (const timezone of ["UTC", "GMT"]) {
      expect(resolve({ from: "2026-10-16", timezone })).toMatchObject([
        { bedAt: "2026-10-17T00:00:00Z", wakeAt: "2026-10-17T08:30:00Z", prepReminderAt: "2026-10-16T23:30:00Z" },
      ]);
    }
    expect(resolve({ from: "2026-10-16", timezone: "Etc/UTC" })).toMatchObject([
      {
        bedAt: "2026-10-17T00:00:00+00:00",
        wakeAt: "2026-10-17T08:30:00+00:00",
        prepReminderAt: "2026-10-16T23:30:00+00:00",
      },
    ]);
  });

  it.each([
    ["from", { from: "16.10.2026", to: "2026-10-16" }],
    ["from", { from: "2026-02-30", to: "2026-10-16" }],
    ["to", { from: "2026-10-16", to: "2026-10-1" }],
    ["to", { from: "2026-10-16", to: "2026-13-01" }],
    // Other ISO 8601 forms of a real day are not `YYYY-MM-DD`.
    ["from", { from: "2026-W42-5", to: "2026-10-16" }],
    ["to", { from: "2026-10-16", to: "2026-10-16T00:00" }],
    // `from` after `to`.
    ["from", { from: "2026-10-17", to: "2026-10-16" }],
    ["timezone", { from: "2026-10-16", to: "2026-10-16", timezone: "Europe/Nowhere" }],
    // A range that resolves no night still refuses the zone.
    ["timezone", { from: "2026-10-16", to: "2026-10-16", timezone: "Europe/Nowhere", plans: [] }],
  ])("throws ValidationError naming %s for %j", (field, input) => {
    const error = thrownBy(() => resolve(input));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ status: 400, details: { field } });
  });

  it("throws the ValidationError of wallClockToInstant for a plan or exception time that is not HH:MM", () => {
    const malformedPlan: SleepPlan = { ...WEEKEND, bedTime: "7:5" };
    const cases = [
      () => resolve({ from: "2026-10-16", plans: [malformedPlan] }),
      () => resolve({ from: "2026-10-16", nights: [exception("2026-10-16", { wakeTime: "25:00" })] }),
    ];

    for (const run of cases) {
      const error = thrownBy(run);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ status: 400, details: { field: "time" } });
    }
    // The same malformed plan does not matter for a night it does not apply to.
    expect(resolve({ from: "2026-10-15", plans: [WEEKDAYS, malformedPlan] })).toHaveLength(1);
  });

  it("throws ValidationError when an instant cannot be rendered", () => {
    const error = thrownBy(() =>
      resolve({ from: "2026-10-16", settings: { prepReminder: true, prepReminderMinutes: Number.MAX_SAFE_INTEGER } }),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ details: { field: "instant" } });
  });
});
