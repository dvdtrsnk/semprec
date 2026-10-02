import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "../propertiesStore.js";

const CONSTRAINT = "properties_database_id_key_key";

describe("isUniqueViolation", () => {
  it("is true for a 23505 error naming the constraint", () => {
    expect(isUniqueViolation({ code: "23505", constraint: CONSTRAINT }, CONSTRAINT)).toBe(true);
  });

  it("is false for a 23505 error naming another constraint", () => {
    expect(isUniqueViolation({ code: "23505", constraint: "other" }, CONSTRAINT)).toBe(false);
  });

  it("is false for the right constraint with another code", () => {
    expect(isUniqueViolation({ code: "23503", constraint: CONSTRAINT }, CONSTRAINT)).toBe(false);
  });

  it("is false for null, undefined, a string and an object without code", () => {
    expect(isUniqueViolation(null, CONSTRAINT)).toBe(false);
    expect(isUniqueViolation(undefined, CONSTRAINT)).toBe(false);
    expect(isUniqueViolation("23505", CONSTRAINT)).toBe(false);
    expect(isUniqueViolation({ constraint: CONSTRAINT }, CONSTRAINT)).toBe(false);
  });
});
