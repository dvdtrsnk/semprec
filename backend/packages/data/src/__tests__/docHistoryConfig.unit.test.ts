import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOC_HISTORY_RETENTION_DAYS,
  resolveDocHistoryRetentionDays,
  retentionHours,
} from "../docs/docHistoryConfig.js";

describe("resolveDocHistoryRetentionDays", () => {
  it("defaults to 30 when DOC_HISTORY_RETENTION_DAYS is unset", () => {
    expect(DEFAULT_DOC_HISTORY_RETENTION_DAYS).toBe(30);
    expect(resolveDocHistoryRetentionDays({})).toBe(30);
  });

  it("accepts a positive integer", () => {
    expect(resolveDocHistoryRetentionDays({ DOC_HISTORY_RETENTION_DAYS: "7" })).toBe(7);
    expect(resolveDocHistoryRetentionDays({ DOC_HISTORY_RETENTION_DAYS: "1" })).toBe(1);
  });

  it.each(["0", "-1", "1.5", "abc", ""])("rejects invalid value %j", (raw) => {
    expect(() => resolveDocHistoryRetentionDays({ DOC_HISTORY_RETENTION_DAYS: raw })).toThrow(
      /DOC_HISTORY_RETENTION_DAYS must be a positive integer/,
    );
  });
});

describe("retentionHours", () => {
  it("is exactly 24 hours per retention day, independent of DST/timezone", () => {
    expect(retentionHours(1)).toBe(24);
    expect(retentionHours(30)).toBe(720);
  });
});
