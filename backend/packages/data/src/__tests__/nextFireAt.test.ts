import { describe, expect, it } from "vitest";
import { computeNextFireAt } from "../scheduler/nextFireAt.js";
import type { HeartbeatRule } from "../scheduler/rule.js";

const TZ = "Europe/Prague";

describe("computeNextFireAt", () => {
  it("dailyTime: returns today's occurrence if still ahead, else tomorrow's", () => {
    const rule: HeartbeatRule = { kind: "dailyTime", at: "09:00" };
    const before = new Date("2026-01-05T06:00:00.000Z"); // 07:00 local (winter, UTC+1)
    const next = computeNextFireAt(rule, TZ, before)!;
    expect(next.toISOString()).toBe("2026-01-05T08:00:00.000Z"); // 09:00 local

    const after = new Date("2026-01-05T09:00:00.000Z"); // 10:00 local, already past 09:00
    const next2 = computeNextFireAt(rule, TZ, after)!;
    expect(next2.toISOString()).toBe("2026-01-06T08:00:00.000Z");
  });

  it("weekly: finds the next matching weekday at the given local time", () => {
    const rule: HeartbeatRule = { kind: "weekly", days: ["mon"], at: "09:00" };
    // 2026-01-05 is a Monday; reference just before 09:00 local should hit that same day
    const ref = new Date("2026-01-05T07:00:00.000Z");
    const next = computeNextFireAt(rule, TZ, ref)!;
    expect(next.toISOString()).toBe("2026-01-05T08:00:00.000Z");

    // reference just after should roll to the following Monday
    const ref2 = new Date("2026-01-05T09:00:00.000Z");
    const next2 = computeNextFireAt(rule, TZ, ref2)!;
    expect(next2.toISOString()).toBe("2026-01-12T08:00:00.000Z");
  });

  it("everyNDays: n days after the reference, at the given local time", () => {
    const rule: HeartbeatRule = { kind: "everyNDays", n: 3, at: "09:00" };
    const ref = new Date("2026-01-05T10:00:00.000Z");
    const next = computeNextFireAt(rule, TZ, ref)!;
    expect(next.toISOString()).toBe("2026-01-08T08:00:00.000Z");
  });

  it("interval: a pure duration added to the reference, ignoring wall-clock time", () => {
    const rule: HeartbeatRule = { kind: "interval", minutes: 30 };
    const ref = new Date("2026-01-05T10:00:00.000Z");
    const next = computeNextFireAt(rule, TZ, ref)!;
    expect(next.toISOString()).toBe("2026-01-05T10:30:00.000Z");
  });

  it("onItemEvent: has no next_fire_at at all", () => {
    const rule: HeartbeatRule = { kind: "onItemEvent", databaseId: "00000000-0000-0000-0000-000000000000", event: "create" };
    expect(computeNextFireAt(rule, TZ, new Date())).toBeNull();
  });
});
