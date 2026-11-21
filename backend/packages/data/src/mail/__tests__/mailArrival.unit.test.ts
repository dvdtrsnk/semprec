import { describe, expect, it } from "vitest";
import { MAIL_LIVE_ARRIVAL_DATE_GRACE_MS, mailArrivalOf } from "../mailArrival.js";

const connectedAt = new Date("2026-11-20T10:00:00.000Z");
const offset = (ms: number) => new Date(connectedAt.getTime() + ms);

describe("mailArrivalOf", () => {
  it.each([
    { name: "a new message dated after the connection", reportedNew: true, date: offset(60_000), arrival: "live" },
    { name: "a new message without a Date", reportedNew: true, date: undefined, arrival: "live" },
    {
      name: "a new message dated exactly one day before the connection",
      reportedNew: true,
      date: offset(-MAIL_LIVE_ARRIVAL_DATE_GRACE_MS),
      arrival: "live",
    },
    {
      name: "a new message dated more than one day before the connection",
      reportedNew: true,
      date: offset(-MAIL_LIVE_ARRIVAL_DATE_GRACE_MS - 1),
      arrival: "backfill",
    },
    {
      name: "a listed message dated after the connection",
      reportedNew: false,
      date: offset(60_000),
      arrival: "backfill",
    },
    { name: "a listed message without a Date", reportedNew: false, date: undefined, arrival: "backfill" },
  ] as const)("judges $name as $arrival", ({ reportedNew, date, arrival }) => {
    expect(mailArrivalOf({ reportedNew, date, connectedAt })).toBe(arrival);
  });
});
