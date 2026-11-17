import { describe, expect, it } from "vitest";
import { formatDateTime, formatUsd } from "../format.js";

describe("formatUsd", () => {
  it("formats USD for en", () => {
    expect(formatUsd("en", 3.55)).toBe("$3.55");
  });

  it("formats USD for cs", () => {
    expect(formatUsd("cs", 3.55)).toBe("3,55\u00A0US$");
  });
});

describe("formatDateTime", () => {
  const instant = "2026-09-27T08:00:00.000Z";

  it("renders an em dash for a null timestamp", () => {
    expect(formatDateTime("en", null)).toBe("—");
  });

  it("returns an unparseable string unchanged", () => {
    expect(formatDateTime("en", "not-a-date")).toBe("not-a-date");
  });

  it("formats a fixed instant the same way Intl.DateTimeFormat does, for en and cs", () => {
    const date = new Date(instant);
    expect(formatDateTime("en", instant)).toBe(
      new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date),
    );
    expect(formatDateTime("cs", instant)).toBe(
      new Intl.DateTimeFormat("cs", { dateStyle: "medium", timeStyle: "short" }).format(date),
    );
  });
});
