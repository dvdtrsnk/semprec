import { describe, expect, it } from "vitest";
import { buildSpeakerSuggestionRequest, parseSpeakerSuggestionContent } from "./speakerSuggestion.js";

const segments = [
  { speaker: "SPEAKER_00", text: "Thanks, Alice.", startsAt: 0, endsAt: 1 },
  { speaker: "SPEAKER_01", text: "Sure.", startsAt: 1, endsAt: 2 },
];

describe("buildSpeakerSuggestionRequest", () => {
  it("asks about the unmapped speakers with the participants and the transcript, unattributed to a project", () => {
    const request = buildSpeakerSuggestionRequest(segments, {
      unmappedSpeakers: ["SPEAKER_01"],
      candidates: [{ id: "person-1", name: "Alice" }],
    });

    expect(request).toMatchObject({
      projectItemId: null,
      operation: "transcript_speaker_suggestion",
      temperature: 0,
    });
    expect(request.messages).toEqual([
      {
        role: "user",
        content:
          "Speakers to identify:\nSPEAKER_01\n\nParticipants (id: name):\nperson-1: Alice\n\n" +
          "Transcript:\nSPEAKER_00: Thanks, Alice.\nSPEAKER_01: Sure.",
      },
    ]);
  });
});

describe("parseSpeakerSuggestionContent", () => {
  it("returns the mappings of a well-formed response", () => {
    expect(parseSpeakerSuggestionContent({ mappings: [{ speaker: "SPEAKER_01", personId: "person-1" }] })).toEqual([
      { speaker: "SPEAKER_01", personId: "person-1" },
    ]);
  });

  it("rejects a response without mappings", () => {
    expect(() => parseSpeakerSuggestionContent({ summary: "no" })).toThrow();
  });

  it("rejects a mapping without a personId", () => {
    expect(() => parseSpeakerSuggestionContent({ mappings: [{ speaker: "SPEAKER_01" }] })).toThrow();
  });
});
