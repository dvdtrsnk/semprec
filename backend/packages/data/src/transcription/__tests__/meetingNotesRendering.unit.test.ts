import { describe, expect, it } from "vitest";
import { parseStoredMeetingNotes, renderMeetingNotes, type StoredMeetingNotes } from "../meetingNotesRendering.js";
import type { TranscriptSpeaker } from "../transcriptionSpeakerEdges.js";

const NOTES: StoredMeetingNotes = {
  title: "{SPEAKER_00} and {SPEAKER_02} on pricing",
  summary: "{SPEAKER_02} asked {SPEAKER_01} about {SPEAKER_07}'s offer.",
  shortSummary: "{SPEAKER_02} needs the pricing.",
  decisions: ["{SPEAKER_00} owns the offer"],
  actionItems: [
    { text: "{SPEAKER_02} sends the contract", ownerSpeaker: "SPEAKER_02", due: "2026-10-17", startsAt: 12.5 },
    { text: "Book a room", ownerSpeaker: "SPEAKER_01", due: null, startsAt: null },
    { text: "Ask around", ownerSpeaker: null, due: null, startsAt: 3 },
  ],
};

const SPEAKERS: TranscriptSpeaker[] = [
  { speaker: "SPEAKER_00", ordinal: 1, person: { id: "p0", name: "Petr Novák" } },
  { speaker: "SPEAKER_01", ordinal: 2, person: null },
  { speaker: "SPEAKER_02", ordinal: 3, person: { id: "p2", name: "Jana Kovářová" } },
];

describe("renderMeetingNotes (issue #1695)", () => {
  it("names mapped speakers by first name in text and full name as owner, Speaker N otherwise, and numbers the items", async () => {
    expect(await renderMeetingNotes(NOTES, SPEAKERS, "en")).toEqual({
      title: "Petr and Jana on pricing",
      summary: "Jana asked Speaker 2 about Speaker's offer.",
      shortSummary: "Jana needs the pricing.",
      decisions: ["Petr owns the offer"],
      actionItems: [
        {
          id: 0,
          text: "Jana sends the contract",
          ownerSpeaker: "SPEAKER_02",
          ownerLabel: "Jana Kovářová",
          due: "2026-10-17",
          startsAt: 12.5,
        },
        { id: 1, text: "Book a room", ownerSpeaker: "SPEAKER_01", ownerLabel: "Speaker 2", due: null, startsAt: null },
        { id: 2, text: "Ask around", ownerSpeaker: null, ownerLabel: null, due: null, startsAt: 3 },
      ],
    });
  });

  it("uses the Czech labels for an unmapped speaker and an unknown token", async () => {
    const rendered = await renderMeetingNotes(NOTES, SPEAKERS, "cs");
    expect(rendered.summary).toBe("Jana asked Mluvčí 2 about Mluvčí's offer.");
    expect(rendered.actionItems[1]?.ownerLabel).toBe("Mluvčí 2");
  });

  it("treats a mapped person without a name like an unmapped speaker", async () => {
    const rendered = await renderMeetingNotes(
      NOTES,
      SPEAKERS.map((speaker) =>
        speaker.speaker === "SPEAKER_02" ? { ...speaker, person: { id: "p2", name: null } } : speaker,
      ),
      "en",
    );
    expect(rendered.shortSummary).toBe("Speaker 3 needs the pricing.");
    expect(rendered.actionItems[0]?.ownerLabel).toBe("Speaker 3");
  });

  it("names an owner that is not a speaker of the transcript with the generic word", async () => {
    const rendered = await renderMeetingNotes(
      { ...NOTES, actionItems: [{ text: "x", ownerSpeaker: "SPEAKER_09", due: null, startsAt: null }] },
      SPEAKERS,
      "en",
    );
    expect(rendered.actionItems[0]?.ownerLabel).toBe("Speaker");
  });
});

describe("parseStoredMeetingNotes", () => {
  it("is null without the key and the notes when valid", () => {
    expect(parseStoredMeetingNotes(undefined)).toBeNull();
    expect(parseStoredMeetingNotes(NOTES)).toEqual(NOTES);
  });

  it("throws on a malformed stored value", () => {
    expect(() => parseStoredMeetingNotes({ title: "only" })).toThrow();
  });
});
