import { describe, expect, it } from "vitest";
import { MAIL_FULL_CONTENT_WINDOW_DAYS, mailContentStateOf } from "../mailContentState.js";

const connectedAt = new Date("2026-11-20T10:00:00.000Z");
const WINDOW_MS = MAIL_FULL_CONTENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const offset = (ms: number) => new Date(connectedAt.getTime() + ms);

describe("mailContentStateOf", () => {
  it.each([
    { name: "live mail dated after the connection", arrival: "live", date: offset(60_000), state: "full" },
    { name: "live mail dated before the window", arrival: "live", date: offset(-WINDOW_MS - 1), state: "full" },
    { name: "live mail without a Date", arrival: "live", date: undefined, state: "full" },
    { name: "history dated after the connection", arrival: "backfill", date: offset(60_000), state: "full" },
    { name: "history dated at the window's start", arrival: "backfill", date: offset(-WINDOW_MS), state: "full" },
    { name: "history dated before the window", arrival: "backfill", date: offset(-WINDOW_MS - 1), state: "index" },
    { name: "history without a Date", arrival: "backfill", date: undefined, state: "index" },
  ] as const)("stores $name as $state", ({ arrival, date, state }) => {
    expect(mailContentStateOf({ arrival, date, connectedAt })).toBe(state);
  });
});
