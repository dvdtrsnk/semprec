import { describe, expect, it } from "vitest";
import { ValidationError } from "@semprec/data";
import {
  optionalIntegerField,
  POSTGRES_INT4_MAX,
  POSTGRES_INT4_MIN,
  requireIntegerField,
} from "../requestValidation.js";

function expectFieldValidationError(fn: () => unknown, field: string): void {
  expect(fn).toThrow(ValidationError);
  try {
    fn();
    throw new Error("expected fn to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).details).toMatchObject({ field });
  }
}

describe("requireIntegerField", () => {
  it("returns an in-range integer", () => {
    expect(requireIntegerField({ count: 3 }, "count")).toBe(3);
  });

  it("accepts the full int4 range by default", () => {
    expect(requireIntegerField({ count: POSTGRES_INT4_MIN }, "count")).toBe(POSTGRES_INT4_MIN);
    expect(requireIntegerField({ count: POSTGRES_INT4_MAX }, "count")).toBe(POSTGRES_INT4_MAX);
  });

  it("rejects a missing field", () => {
    expectFieldValidationError(() => requireIntegerField({}, "count"), "count");
  });

  it("rejects Infinity (what a body literal wide enough to overflow float64, e.g. 1e309, parses to)", () => {
    expectFieldValidationError(() => requireIntegerField({ count: Infinity }, "count"), "count");
  });

  it("rejects a non-integer number", () => {
    expectFieldValidationError(() => requireIntegerField({ count: 1.5 }, "count"), "count");
  });

  it("rejects a value below the int4 minimum", () => {
    expectFieldValidationError(() => requireIntegerField({ count: POSTGRES_INT4_MIN - 1 }, "count"), "count");
  });

  it("rejects a value above the int4 maximum", () => {
    expectFieldValidationError(() => requireIntegerField({ count: POSTGRES_INT4_MAX + 1 }, "count"), "count");
  });

  it("rejects a string that looks numeric", () => {
    expectFieldValidationError(() => requireIntegerField({ count: "3" }, "count"), "count");
  });

  it("rejects a negative value when nonNegative is set", () => {
    expectFieldValidationError(
      () => requireIntegerField({ position: -1 }, "position", { nonNegative: true }),
      "position",
    );
  });

  it("accepts zero when nonNegative is set", () => {
    expect(requireIntegerField({ position: 0 }, "position", { nonNegative: true })).toBe(0);
  });
});

describe("optionalIntegerField", () => {
  it("returns undefined when the field is absent", () => {
    expect(optionalIntegerField({}, "position")).toBeUndefined();
  });

  it("returns the value when present and valid", () => {
    expect(optionalIntegerField({ position: 5 }, "position")).toBe(5);
  });

  it("rejects Infinity", () => {
    expectFieldValidationError(() => optionalIntegerField({ position: Infinity }, "position"), "position");
  });

  it("rejects a non-integer number", () => {
    expectFieldValidationError(() => optionalIntegerField({ position: 1.5 }, "position"), "position");
  });

  it("rejects a negative value when nonNegative is set", () => {
    expectFieldValidationError(
      () => optionalIntegerField({ position: -1 }, "position", { nonNegative: true }),
      "position",
    );
  });

  it("rejects a value exceeding the int4 maximum", () => {
    expectFieldValidationError(() => optionalIntegerField({ position: 2147483648 }, "position"), "position");
  });
});
