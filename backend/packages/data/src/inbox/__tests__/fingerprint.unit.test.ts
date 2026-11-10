import { describe, expect, it } from "vitest";
import {
  computeInboxFingerprint,
  computeInboxFingerprintV2,
  isFingerprintCurrent,
  type InboxFingerprintV2Input,
} from "../fingerprint.js";

// The vectors below are digests of the canonical JSON written out by hand, so they pin the formula
// rather than re-running it. The emoji is U+2611 followed by U+FE0F (variation selector 16).
const EMOJI = "☑️";

const base: InboxFingerprintV2Input = {
  typeId: "type-1",
  text: "Buy milk",
  date: "2026-08-28",
  time: "09:00",
  attachmentHashes: ["a", "b"],
  transcribedText: "",
};

describe("computeInboxFingerprint (version 1, issue #223)", () => {
  it("keeps the version 1 formula: the SHA-256 of the JSON of emoji and text", () => {
    expect(computeInboxFingerprint(EMOJI, "Buy milk")).toBe(
      "639c77ed94f33f1e3d2098c9257b8e1bcd923ae197dd2afa9958c7a251394f3a",
    );
  });
});

describe("computeInboxFingerprintV2 (issue #1606)", () => {
  it("is 'v2:' followed by the SHA-256 of the canonical JSON of the input", () => {
    expect(computeInboxFingerprintV2(base)).toBe("v2:ef1366466245054181055dd9c3983c57a7cef36c0c1a4304e68f170973434dfc");
  });

  it("does not depend on the order of the input's keys", () => {
    const reordered: InboxFingerprintV2Input = {
      transcribedText: "",
      attachmentHashes: ["a", "b"],
      time: "09:00",
      date: "2026-08-28",
      text: "Buy milk",
      typeId: "type-1",
    };
    expect(computeInboxFingerprintV2(reordered)).toBe(computeInboxFingerprintV2(base));
  });

  it("does not depend on the order of the attachment hashes, and does not reorder the caller's array", () => {
    const hashes = ["b", "a"];
    expect(computeInboxFingerprintV2({ ...base, attachmentHashes: hashes })).toBe(computeInboxFingerprintV2(base));
    expect(hashes).toEqual(["b", "a"]);
  });

  it.each([
    ["the date", { date: "2026-08-29" }],
    ["the time", { time: "10:30" }],
    ["the type id", { typeId: "type-2" }],
    ["the text", { text: "Buy bread" }],
    ["the transcript text", { transcribedText: "milk" }],
    ["an added attachment", { attachmentHashes: ["a", "b", "c"] }],
    ["a removed attachment", { attachmentHashes: ["a"] }],
    ["a replaced attachment", { attachmentHashes: ["a", "c"] }],
  ])("changes when %s changes", (_label, change) => {
    expect(computeInboxFingerprintV2({ ...base, ...change })).not.toBe(computeInboxFingerprintV2(base));
  });
});

describe("isFingerprintCurrent (issue #1606)", () => {
  const current = { v2Input: base, legacyEmoji: EMOJI, legacyText: "Buy milk" };

  it("a version 2 value is current when it equals the version 2 fingerprint of the input", () => {
    expect(isFingerprintCurrent(computeInboxFingerprintV2(base), current)).toBe(true);
  });

  it("a version 2 value is stale when any field of the input changed", () => {
    const stored = computeInboxFingerprintV2(base);
    expect(isFingerprintCurrent(stored, { ...current, v2Input: { ...base, time: "10:30" } })).toBe(false);
  });

  it("a version 2 value ignores the legacy emoji and text", () => {
    const stored = computeInboxFingerprintV2(base);
    expect(isFingerprintCurrent(stored, { ...current, legacyEmoji: "📌", legacyText: "other" })).toBe(true);
  });

  it("a version 1 value is current while its emoji and text are unchanged, whatever the date, time and attachments", () => {
    const stored = computeInboxFingerprint(EMOJI, "Buy milk");
    expect(isFingerprintCurrent(stored, current)).toBe(true);
    expect(
      isFingerprintCurrent(stored, { ...current, v2Input: { ...base, time: "10:30", attachmentHashes: ["x"] } }),
    ).toBe(true);
  });

  it("a version 1 value is stale when its emoji changed", () => {
    const stored = computeInboxFingerprint(EMOJI, "Buy milk");
    expect(isFingerprintCurrent(stored, { ...current, legacyEmoji: "📌" })).toBe(false);
  });

  it("a version 1 value is stale when its text changed", () => {
    const stored = computeInboxFingerprint(EMOJI, "Buy milk");
    expect(isFingerprintCurrent(stored, { ...current, legacyText: "Buy bread" })).toBe(false);
  });

  it.each([null, undefined, 42, ""])("a stored value that is not a fingerprint (%s) is stale", (stored) => {
    expect(isFingerprintCurrent(stored, current)).toBe(false);
  });
});
