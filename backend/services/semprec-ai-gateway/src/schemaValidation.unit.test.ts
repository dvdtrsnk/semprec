import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compileResponseSchema } from "./schemaValidation.js";

/**
 * A test-only copy of the meetingNotes `responseSchema` that semprec-transcribe's
 * `buildMeetingNotesRequest` sends (issue #1695); its production owner is
 * `services/semprec-transcribe/src/transcriptSummary.ts`. This process cannot import that service, so
 * identity is checked by digest: the transcribe test asserts the same SHA-256 for the schema its
 * request builder actually sends. This is the gateway compiler's acceptance of those bytes, not an
 * HTTP or live-provider check.
 */
const MEETING_NOTES_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    shortSummary: { type: "string" },
    decisions: { type: "array", items: { type: "string" } },
    actionItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          ownerSpeaker: { type: ["string", "null"] },
          due: { type: ["string", "null"] },
          startsAt: { type: ["number", "null"] },
        },
        required: ["text", "ownerSpeaker", "due", "startsAt"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "summary", "shortSummary", "decisions", "actionItems"],
  additionalProperties: false,
};

const MEETING_NOTES_SCHEMA_SHA256 = "481e33795b2172342979a4ed0ceb3fdc008043895bb4bdbde8595bee0f9bb6dc";

const NOTES = { title: "Launch", summary: "Shipped.", shortSummary: "Ship.", decisions: ["Ship"] };

describe("compileResponseSchema accepts the meetingNotes schema (issue #1695)", () => {
  it("compiles the exact schema bytes the transcribe request builder sends", () => {
    expect(createHash("sha256").update(JSON.stringify(MEETING_NOTES_RESPONSE_SCHEMA)).digest("hex")).toBe(
      MEETING_NOTES_SCHEMA_SHA256,
    );
    expect(() => compileResponseSchema(MEETING_NOTES_RESPONSE_SCHEMA)).not.toThrow();
  });

  it("accepts null and populated owner, due and start, and an empty action list", () => {
    const validate = compileResponseSchema(MEETING_NOTES_RESPONSE_SCHEMA);
    for (const content of [
      { ...NOTES, actionItems: [] },
      { ...NOTES, actionItems: [{ text: "Send", ownerSpeaker: null, due: null, startsAt: null }] },
      { ...NOTES, actionItems: [{ text: "Send", ownerSpeaker: "SPEAKER_01", due: "2026-10-17", startsAt: 12.5 }] },
    ]) {
      expect(validate(content), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it.each([
    ["a wrong owner type", { ...NOTES, actionItems: [{ text: "Send", ownerSpeaker: 1, due: null, startsAt: null }] }],
    [
      "a wrong start type",
      { ...NOTES, actionItems: [{ text: "Send", ownerSpeaker: null, due: null, startsAt: "12" }] },
    ],
    ["a missing nullable field", { ...NOTES, actionItems: [{ text: "Send", ownerSpeaker: null, due: null }] }],
    ["a missing top-level field", { title: "Launch", summary: "", decisions: [], actionItems: [] }],
    ["an extra field", { ...NOTES, actionItems: [], extra: true }],
    ["a non-array of decisions", { ...NOTES, decisions: "Ship", actionItems: [] }],
  ])("rejects %s", (_label, content) => {
    expect(compileResponseSchema(MEETING_NOTES_RESPONSE_SCHEMA)(content)).toBe(false);
  });
});
