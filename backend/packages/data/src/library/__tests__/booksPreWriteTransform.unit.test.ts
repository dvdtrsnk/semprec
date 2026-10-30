import { describe, expect, it } from "vitest";
import { booksPreWriteTransform } from "../booksPreWriteTransform.js";
import { ValidationError } from "../../errors.js";

describe("Books publication year pre-write transform", () => {
  it.each([2019, 0, -5, 2019.5, null])("preserves a valid year %s without coercion or mutation", async (year) => {
    const patch = Object.freeze({ year, isbn: "9788074325014" });
    expect(await booksPreWriteTransform({ patch })).toBe(patch);
  });

  it.each(["2019", "", undefined, NaN, Infinity, -Infinity, true, {}, []])(
    "refuses a supplied invalid year %s with the field-specific validation error",
    async (year) => {
      const patch = Object.freeze({ year });
      await expect(booksPreWriteTransform({ patch })).rejects.toBeInstanceOf(ValidationError);
      await expect(booksPreWriteTransform({ patch })).rejects.toMatchObject({
        code: "validation_failed",
        details: { field: "year" },
      });
    },
  );

  it.each([{}, { isbn: "9788074325014" }, { name: "Renamed" }, { rating: 3 }])(
    "leaves a patch omitting year unchanged: %s",
    async (patch) => {
      Object.freeze(patch);
      expect(await booksPreWriteTransform({ patch })).toBe(patch);
    },
  );
});
