import { describe, expect, it } from "vitest";
import { buildSummaryRequest, DEFAULT_SUMMARY_INSTRUCTION, parseSummaryContent } from "./transcriptSummary.js";

const SEGMENTS = [
  { speaker: "SPEAKER_00", text: "Let's ship it.", startsAt: 0, endsAt: 1 },
  { speaker: "SPEAKER_01", text: "Agreed.", startsAt: 1.2, endsAt: 2 },
];

describe("buildSummaryRequest", () => {
  it("sends the instruction and the rendered transcript as an unattributed transcript_summary call", () => {
    const request = buildSummaryRequest(SEGMENTS, "cs", DEFAULT_SUMMARY_INSTRUCTION);

    expect(request).toMatchObject({ projectItemId: null, operation: "transcript_summary" });
    expect(request.system).toContain("(cs)");
    expect(request.messages).toEqual([
      {
        role: "user",
        content: `Instruction:\n${DEFAULT_SUMMARY_INSTRUCTION.prompt}\n\nTranscript:\nSPEAKER_00: Let's ship it.\nSPEAKER_01: Agreed.`,
      },
    ]);
  });

  it("asks for the transcript's own language when none was detected", () => {
    const request = buildSummaryRequest(SEGMENTS, null, DEFAULT_SUMMARY_INSTRUCTION);

    expect(request.system).toContain("in the language the transcript is in");
  });
});

describe("parseSummaryContent", () => {
  it("returns the summary text", () => {
    expect(parseSummaryContent({ summary: "Shipped." })).toBe("Shipped.");
  });

  it.each([null, "Shipped.", { summary: 42 }, {}])("rejects malformed content %j", (content) => {
    expect(() => parseSummaryContent(content)).toThrow();
  });
});
