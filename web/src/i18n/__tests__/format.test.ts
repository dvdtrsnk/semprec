import { describe, expect, it } from "vitest";
import { formatByteSize, formatDateTime, formatUsd } from "../format.js";

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

describe("formatByteSize", () => {
  const unit = (locale: "cs" | "en", value: number, name: string, maximumFractionDigits: number) =>
    new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "short", maximumFractionDigits }).format(
      value,
    );

  it.each([
    { bytes: 0, value: 0, name: "byte", digits: 0 },
    { bytes: 1023, value: 1023, name: "byte", digits: 0 },
    { bytes: 1536, value: 1.5, name: "kilobyte", digits: 1 },
    { bytes: 5 * 1024 * 1024, value: 5, name: "megabyte", digits: 1 },
    { bytes: 3 * 1024 ** 4, value: 3 * 1024, name: "gigabyte", digits: 1 },
  ])("formats $bytes bytes in the largest binary unit it reaches, for en and cs", ({ bytes, value, name, digits }) => {
    expect(formatByteSize("en", bytes)).toBe(unit("en", value, name, digits));
    expect(formatByteSize("cs", bytes)).toBe(unit("cs", value, name, digits));
  });
});
