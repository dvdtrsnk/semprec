import { describe, expect, it } from "vitest";
import { normalizeSearchPhone } from "../phoneNormalization.js";

describe("normalizeSearchPhone", () => {
  it.each([
    ["777 123 456", "420777123456"],
    ["+420 (777) 123-456", "420777123456"],
    ["0049 123 456789", "49123456789"],
    ["", ""],
  ])("normalizes %s", (input, expected) => expect(normalizeSearchPhone(input)).toBe(expected));
});
