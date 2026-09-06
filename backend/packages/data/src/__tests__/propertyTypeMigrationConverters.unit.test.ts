import { describe, expect, it } from "vitest";
import { convertPropertyValue, isConversionSupported } from "../migrationJob/propertyTypeMigration.js";

describe("isConversionSupported", () => {
  it("is always true for a same-type retype (a no-op conversion)", () => {
    expect(isConversionSupported("text", "text")).toBe(true);
  });

  it("is true only for the fixed, deliberately non-exhaustive set of registered type pairs", () => {
    expect(isConversionSupported("text", "number")).toBe(true);
    expect(isConversionSupported("text", "date")).toBe(true);
    expect(isConversionSupported("number", "text")).toBe(true);
    expect(isConversionSupported("date", "text")).toBe(true);

    expect(isConversionSupported("number", "date")).toBe(false);
    expect(isConversionSupported("date", "number")).toBe(false);
    expect(isConversionSupported("select", "text")).toBe(false);
  });
});

describe("convertPropertyValue", () => {
  it("passes any value through unchanged when from === to", () => {
    expect(convertPropertyValue("text", "text", "anything")).toEqual({ ok: true, value: "anything" });
    expect(convertPropertyValue("number", "number", 42)).toEqual({ ok: true, value: 42 });
  });

  it("text -> number: converts numeric strings, rejects non-numeric or blank ones", () => {
    expect(convertPropertyValue("text", "number", "42")).toEqual({ ok: true, value: 42 });
    expect(convertPropertyValue("text", "number", "3.14")).toEqual({ ok: true, value: 3.14 });
    expect(convertPropertyValue("text", "number", "not a number")).toEqual({ ok: false });
    expect(convertPropertyValue("text", "number", "")).toEqual({ ok: false });
    expect(convertPropertyValue("text", "number", "   ")).toEqual({ ok: false });
    expect(convertPropertyValue("text", "number", 42)).toEqual({ ok: false });
  });

  it("text -> date: converts parseable date strings to an ISO timestamp, rejects unparseable ones", () => {
    expect(convertPropertyValue("text", "date", "2024-01-15")).toEqual({ ok: true, value: "2024-01-15T00:00:00.000Z" });
    expect(convertPropertyValue("text", "date", "not a date")).toEqual({ ok: false });
    expect(convertPropertyValue("text", "date", 123)).toEqual({ ok: false });
  });

  it("number -> text: stringifies a number, rejects a non-number", () => {
    expect(convertPropertyValue("number", "text", 42)).toEqual({ ok: true, value: "42" });
    expect(convertPropertyValue("number", "text", "42")).toEqual({ ok: false });
  });

  it("date -> text: passes a string value through, rejects a non-string", () => {
    expect(convertPropertyValue("date", "text", "2024-01-15T00:00:00.000Z")).toEqual({ ok: true, value: "2024-01-15T00:00:00.000Z" });
    expect(convertPropertyValue("date", "text", 123)).toEqual({ ok: false });
  });

  it("has no registered converter for an unsupported pair, regardless of value shape", () => {
    expect(convertPropertyValue("number", "date", 42)).toEqual({ ok: false });
    expect(convertPropertyValue("select", "text", "option-a")).toEqual({ ok: false });
  });
});
