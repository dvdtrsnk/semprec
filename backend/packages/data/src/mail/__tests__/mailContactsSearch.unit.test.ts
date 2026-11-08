import { describe, expect, it } from "vitest";
import { escapeContactSearchPattern } from "../personEmailIndexStore.js";
describe("literal contact search pattern", () => {
  it.each([
    ["novak", "%novak%"],
    ["%", "%\\%%"],
    ["_", "%\\_%"],
    ["\\", "%\\\\%"],
    ["a%_\\b", "%a\\%\\_\\\\b%"],
  ])("escapes %s", (input, expected) => {
    expect(escapeContactSearchPattern(input)).toBe(expected);
  });
});
