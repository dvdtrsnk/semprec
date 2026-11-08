import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildMeetingNotesRequest,
  emptyMeetingNotes,
  MEETING_NOTES_INSTRUCTION,
  MEETING_NOTES_RESPONSE_SCHEMA,
  normalizeMeetingNotes,
  parseMeetingNotesContent,
  recordingDay,
  type MeetingNotes,
} from "./transcriptSummary.js";

const SEGMENTS = [
  { speaker: "SPEAKER_00", text: "Let's ship it.", startsAt: 0, endsAt: 1 },
  { speaker: "SPEAKER_01", text: "I will send the pricing tomorrow.", startsAt: 12.5, endsAt: 14 },
];

/**
 * SHA-256 of `JSON.stringify` of the meetingNotes response schema. The gateway's
 * `schemaValidation.unit.test.ts` asserts the same digest for the literal it compiles, so the schema
 * the request builder sends and the one the gateway compiler is proven to accept are the same bytes.
 */
const MEETING_NOTES_SCHEMA_SHA256 = "481e33795b2172342979a4ed0ceb3fdc008043895bb4bdbde8595bee0f9bb6dc";

function weekdayOf(date: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(new Date(date));
}

function notes(actionItems: MeetingNotes["actionItems"]): MeetingNotes {
  return { title: "Launch", summary: "{SPEAKER_00} decided.", shortSummary: "Ship.", decisions: ["Ship"], actionItems };
}

describe("buildMeetingNotesRequest (issue #1695)", () => {
  it("sends the meetingNotes instruction, the recording day and the timed transcript as a transcript_summary call", () => {
    const day = recordingDay("2026-10-16T08:00:00Z", "Europe/Prague");
    const request = buildMeetingNotesRequest(SEGMENTS, "cs", day);

    expect(MEETING_NOTES_INSTRUCTION.key).toBe("meetingNotes");
    expect(request).toMatchObject({ projectItemId: null, operation: "transcript_summary", temperature: 0 });
    expect(request.system).toContain("(cs)");
    expect(request.messages).toEqual([
      {
        role: "user",
        content:
          `Instruction:\n${MEETING_NOTES_INSTRUCTION.prompt}\n\n` +
          `Recording date: 2026-10-16 (${weekdayOf("2026-10-16T08:00:00Z", "Europe/Prague")})\n\n` +
          "Transcript:\n[0] SPEAKER_00: Let's ship it.\n[12.5] SPEAKER_01: I will send the pricing tomorrow.",
      },
    ]);
    expect(MEETING_NOTES_INSTRUCTION.prompt).toContain("{SPEAKER_00}");
    expect(MEETING_NOTES_INSTRUCTION.prompt).toContain("YYYY-MM-DD");
    expect(request.responseSchema).toBe(MEETING_NOTES_RESPONSE_SCHEMA);
  });

  it("sends exactly the schema bytes the gateway compiler test accepts", () => {
    const request = buildMeetingNotesRequest(SEGMENTS, null, null);
    const digest = createHash("sha256").update(JSON.stringify(request.responseSchema)).digest("hex");
    expect(digest).toBe(MEETING_NOTES_SCHEMA_SHA256);
  });

  it("states an unknown recording date and the transcript's own language when none is known", () => {
    const request = buildMeetingNotesRequest(SEGMENTS, null, null);
    expect(request.system).toContain("in the language the transcript is in");
    expect(request.messages[0]?.content).toContain("\nRecording date: unknown\n");
  });
});

describe("recordingDay", () => {
  it("is the calendar day and weekday of the instant in the tenant's time zone", () => {
    const late = "2026-10-16T22:30:00Z";
    expect(recordingDay(late, "UTC")).toEqual({ date: "2026-10-16", weekday: weekdayOf(late, "UTC") });
    expect(recordingDay(late, "Europe/Prague")).toEqual({
      date: "2026-10-17",
      weekday: weekdayOf(late, "Europe/Prague"),
    });
  });

  it("is null for a value that is not an instant", () => {
    expect(recordingDay("not a date", "UTC")).toBeNull();
  });
});

describe("parseMeetingNotesContent", () => {
  it("returns the notes", () => {
    const content = notes([{ text: "Send pricing", ownerSpeaker: "SPEAKER_01", due: null, startsAt: 12.5 }]);
    expect(parseMeetingNotesContent(content)).toEqual(content);
  });

  it.each([
    null,
    "notes",
    { title: "Only a title" },
    { ...notes([]), decisions: "Ship" },
    { ...notes([]), extra: true },
    { ...notes([]), actionItems: [{ text: "Send", ownerSpeaker: 1, due: null, startsAt: null }] },
    { ...notes([]), actionItems: [{ text: "Send", ownerSpeaker: null, due: null }] },
  ])("rejects malformed content %j", (content) => {
    expect(() => parseMeetingNotesContent(content)).toThrow();
  });
});

describe("normalizeMeetingNotes", () => {
  it("keeps an owner that is a speaker of the segments and nulls any other", () => {
    const normalized = normalizeMeetingNotes(
      notes([
        { text: "a", ownerSpeaker: "SPEAKER_01", due: null, startsAt: null },
        { text: "b", ownerSpeaker: "SPEAKER_07", due: null, startsAt: null },
        { text: "c", ownerSpeaker: "Jana", due: null, startsAt: null },
        { text: "d", ownerSpeaker: "{SPEAKER_00}", due: null, startsAt: null },
      ]),
      SEGMENTS,
    );
    expect(normalized.actionItems.map((item) => item.ownerSpeaker)).toEqual(["SPEAKER_01", null, null, null]);
  });

  it("keeps a due that is a calendar date and nulls anything else", () => {
    const dues = ["2026-10-17", "2026-02-29", "2028-02-29", "2026-02-30", "2026-13-01", "tomorrow", "17.10.2026", ""];
    const normalized = normalizeMeetingNotes(
      notes(dues.map((due) => ({ text: due, ownerSpeaker: null, due, startsAt: null }))),
      SEGMENTS,
    );
    expect(normalized.actionItems.map((item) => item.due)).toEqual([
      "2026-10-17",
      null,
      "2028-02-29",
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("keeps a finite startsAt of at least 0 and nulls a negative one", () => {
    const normalized = normalizeMeetingNotes(
      notes([0, 12.5, -1, null].map((startsAt) => ({ text: "x", ownerSpeaker: null, due: null, startsAt }))),
      SEGMENTS,
    );
    expect(normalized.actionItems.map((item) => item.startsAt)).toEqual([0, 12.5, null, null]);
  });

  it("keeps the text, the summary fields and the order of the items", () => {
    const content = notes([
      { text: "first", ownerSpeaker: null, due: null, startsAt: null },
      { text: "second", ownerSpeaker: null, due: null, startsAt: null },
    ]);
    const normalized = normalizeMeetingNotes(content, SEGMENTS);
    expect({ ...normalized, actionItems: [] }).toEqual({ ...content, actionItems: [] });
    expect(normalized.actionItems.map((item) => item.text)).toEqual(["first", "second"]);
  });

  it("stores empty notes as empty strings and empty lists", () => {
    expect(emptyMeetingNotes()).toEqual({ title: "", summary: "", shortSummary: "", decisions: [], actionItems: [] });
  });
});

describe("a relative due date (stubbed model)", () => {
  /**
   * A deterministic stand-in for the model: it reads the recording date line of the actual request
   * and resolves "tomorrow" from it. It proves the request carries the date the model needs and
   * that normalization keeps a valid result; it is not evidence of a live model's quality.
   */
  function stubbedModel(content: string, answer: "tomorrow" | "invalid"): MeetingNotes {
    const match = /Recording date: (\d{4})-(\d{2})-(\d{2})/.exec(content);
    if (!match) throw new Error("The request has no recording date");
    const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
    const due = answer === "tomorrow" ? next.toISOString().slice(0, 10) : "next Friday";
    return notes([{ text: "Send the pricing", ownerSpeaker: "SPEAKER_01", due, startsAt: 12.5 }]);
  }

  it.each([
    ["tomorrow", "2026-10-17"],
    ["invalid", null],
  ] as const)("resolves %s in a recording of 2026-10-16 to %s", (answer, expected) => {
    const request = buildMeetingNotesRequest(SEGMENTS, "en", recordingDay("2026-10-16T08:00:00Z", "Europe/Prague"));
    const content = request.messages[0]?.content;
    if (typeof content !== "string") throw new Error("Expected a text message");
    const parsed = parseMeetingNotesContent(stubbedModel(content, answer));
    expect(normalizeMeetingNotes(parsed, SEGMENTS).actionItems[0]?.due).toBe(expected);
  });
});
