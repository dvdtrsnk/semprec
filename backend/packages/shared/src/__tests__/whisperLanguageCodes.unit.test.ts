import { describe, expect, it } from "vitest";
import { normalizeWhisperLanguage } from "../whisperLanguageCodes.js";

describe("normalizeWhisperLanguage", () => {
  it.each([
    ["czech", "cs"],
    ["english", "en"],
    ["  CzEcH ", "cs"],
    [" CS ", "cs"],
    ["castilian", "es"],
    ["flemish", "nl"],
    ["moldavian", "ro"],
    ["moldovan", "ro"],
    ["letzeburgesch", "lb"],
    ["burmese", "my"],
    ["pashto", "ps"],
    ["pushto", "ps"],
    ["panjabi", "pa"],
    ["sinhalese", "si"],
    ["haitian creole", "ht"],
    ["javanese", "jv"],
    ["cantonese", "zh"],
    ["hawaiian", null],
    ["unknown", null],
    ["xx", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("maps %s to %s", (raw, expected) => {
    expect(normalizeWhisperLanguage(raw)).toBe(expected);
  });
});
