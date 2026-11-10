import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors.js";
import { normalizeWallClockTime } from "../timezone.js";

/** Returns what `run` threw, so each assertion can check the error contract (status, code, field). */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("normalizeWallClockTime", () => {
  it("maps null, undefined and the empty string to no time", () => {
    expect(normalizeWallClockTime(null, { field: "timeFrom" })).toBeNull();
    expect(normalizeWallClockTime(undefined, { field: "timeFrom" })).toBeNull();
    expect(normalizeWallClockTime("", { field: "timeFrom" })).toBeNull();
  });

  it("zero-pads a single-digit hour", () => {
    expect(normalizeWallClockTime("9:00", { field: "timeFrom" })).toBe("09:00");
  });

  it("keeps an HH:MM value unchanged", () => {
    expect(normalizeWallClockTime("09:05", { field: "timeFrom" })).toBe("09:05");
  });

  it("accepts the first and last minute of a day", () => {
    expect(normalizeWallClockTime("00:00", { field: "timeFrom" })).toBe("00:00");
    expect(normalizeWallClockTime("23:59", { field: "timeFrom" })).toBe("23:59");
  });

  it("accepts 24:00 as an end time when allow2400 is set", () => {
    expect(normalizeWallClockTime("24:00", { field: "timeTo", allow2400: true })).toBe("24:00");
  });

  it("refuses 24:00 when allow2400 is not set", () => {
    expect(thrownBy(() => normalizeWallClockTime("24:00", { field: "timeFrom" }))).toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { field: "timeFrom" },
    });
  });

  it("refuses any other hour or minute past 24:00 even when allow2400 is set", () => {
    expect(thrownBy(() => normalizeWallClockTime("24:30", { field: "timeTo", allow2400: true }))).toBeInstanceOf(
      ValidationError,
    );
  });

  it("refuses an out-of-range hour and minute", () => {
    expect(thrownBy(() => normalizeWallClockTime("25:99", { field: "timeFrom" }))).toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { field: "timeFrom" },
    });
    expect(thrownBy(() => normalizeWallClockTime("09:60", { field: "timeFrom" }))).toBeInstanceOf(ValidationError);
  });

  it("refuses text that is not a time", () => {
    expect(thrownBy(() => normalizeWallClockTime("abc", { field: "timeFrom" }))).toBeInstanceOf(ValidationError);
  });

  it("refuses a minute with one digit", () => {
    expect(thrownBy(() => normalizeWallClockTime("9:5", { field: "timeFrom" }))).toBeInstanceOf(ValidationError);
  });

  it("refuses surrounding whitespace rather than trimming it", () => {
    expect(thrownBy(() => normalizeWallClockTime(" 9:00", { field: "timeFrom" }))).toBeInstanceOf(ValidationError);
  });

  it("refuses a non-string value", () => {
    expect(thrownBy(() => normalizeWallClockTime(900, { field: "timeFrom" }))).toMatchObject({
      status: 400,
      details: { field: "timeFrom" },
    });
  });
});
