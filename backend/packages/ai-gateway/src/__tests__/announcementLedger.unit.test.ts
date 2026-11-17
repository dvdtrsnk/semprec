import { describe, expect, it } from "vitest";
import { AnnouncementLedger } from "../announcementLedger.js";

const KEY = "tenant|daily|Europe/Prague";

describe("AnnouncementLedger", () => {
  it("lets exactly one claim win while the window is open, and reports it announced", () => {
    const ledger = new AnnouncementLedger();

    expect(ledger.isAnnounced(KEY, 1_000)).toBe(false);
    expect(ledger.claim(KEY, 5_000, 1_000)).toBe(true);
    expect(ledger.claim(KEY, 5_000, 1_500)).toBe(false);
    expect(ledger.isAnnounced(KEY, 4_999)).toBe(true);
  });

  it("keeps claims of other keys apart", () => {
    const ledger = new AnnouncementLedger();
    ledger.claim(KEY, 5_000, 1_000);

    expect(ledger.claim("tenant|monthly|Europe/Prague", 9_000, 1_000)).toBe(true);
    expect(ledger.claim("other|daily|Europe/Prague", 5_000, 1_000)).toBe(true);
  });

  it("forgets a claim at the instant its window ends, so the next window is claimed again", () => {
    const ledger = new AnnouncementLedger();
    ledger.claim(KEY, 5_000, 1_000);

    expect(ledger.isAnnounced(KEY, 5_000)).toBe(false);
    expect(ledger.claim(KEY, 9_000, 5_000)).toBe(true);
    expect(ledger.claim(KEY, 9_000, 6_000)).toBe(false);
  });

  it("drops every ended entry on a later call, whatever key the call is about", () => {
    const ledger = new AnnouncementLedger();
    ledger.claim("a", 2_000, 1_000);
    ledger.claim("b", 3_000, 1_000);
    ledger.claim("c", 9_000, 1_000);

    expect(ledger.isAnnounced("c", 4_000)).toBe(true);
    // "a" and "b" ended before 4_000: claiming them again wins, which only holds if they were dropped.
    expect(ledger.claim("a", 9_000, 4_000)).toBe(true);
    expect(ledger.claim("b", 9_000, 4_000)).toBe(true);
  });

  it("lets a released claim be won again inside the same window", () => {
    const ledger = new AnnouncementLedger();
    ledger.claim(KEY, 5_000, 1_000);

    ledger.release(KEY);

    expect(ledger.isAnnounced(KEY, 2_000)).toBe(false);
    expect(ledger.claim(KEY, 5_000, 2_000)).toBe(true);
  });

  it("ignores the release of a key it never held", () => {
    const ledger = new AnnouncementLedger();

    ledger.release(KEY);

    expect(ledger.claim(KEY, 5_000, 1_000)).toBe(true);
  });
});
