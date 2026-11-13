import { describe, expect, it } from "vitest";
import { buildEventRecommendationRequest, parseEventRecommendationContent } from "./eventRecommendation.js";

const notes = { title: "Sprint planning", summary: "Speaker 1 plans the iOS sprint.", shortSummary: "iOS sprint." };

const candidates = [
  {
    id: "event-1",
    name: "Sprint planning",
    date: "2024-03-01",
    timeFrom: "13:00",
    timeTo: "13:45",
    endDate: null,
    projectId: "project-1",
    projectName: "Apollo",
    participantNames: ["Alice", "Zora"],
  },
  {
    id: "event-2",
    name: "Accountant call",
    date: "2024-03-01",
    timeFrom: "13:30",
    timeTo: null,
    endDate: "2024-03-02",
    projectId: null,
    projectName: null,
    participantNames: [],
  },
];

describe("buildEventRecommendationRequest", () => {
  it("asks which Event it was from the notes and the candidates, unattributed to a project and deterministic", () => {
    const request = buildEventRecommendationRequest(notes, candidates, "cs");

    expect(request).toMatchObject({ projectItemId: null, operation: "transcript_event_match", temperature: 0 });
    expect(request.messages).toEqual([
      {
        role: "user",
        content:
          "Meeting notes:\nTitle: Sprint planning\nSummary: Speaker 1 plans the iOS sprint.\nShort summary: iOS sprint.\n\n" +
          "Events that overlapped the recording:\n" +
          "- id: event-1\n  name: Sprint planning\n  date: 2024-03-01\n  times: 13:00-13:45\n  project: Apollo\n  participants: Alice, Zora\n" +
          "- id: event-2\n  name: Accountant call\n  date: 2024-03-01 to 2024-03-02\n  times: 13:30\n  project: none\n  participants: none",
      },
    ]);
  });

  it("tells the model to answer null when it cannot tell and to write the reason in the user's language", () => {
    const { system } = buildEventRecommendationRequest(notes, candidates, "cs");

    expect(system).toContain("answer with null for eventId");
    expect(system).toContain("in the user's language (cs)");
  });

  it("requires eventId, which may be null, and a reason, with no other property", () => {
    expect(buildEventRecommendationRequest(notes, candidates, "en").responseSchema).toEqual({
      type: "object",
      properties: { eventId: { type: ["string", "null"] }, reason: { type: "string" } },
      required: ["eventId", "reason"],
      additionalProperties: false,
    });
  });
});

describe("parseEventRecommendationContent", () => {
  it("returns the id and the reason of a well-formed answer", () => {
    expect(parseEventRecommendationContent({ eventId: "event-1", reason: "About the sprint." })).toEqual({
      eventId: "event-1",
      reason: "About the sprint.",
    });
  });

  it("accepts a null eventId", () => {
    expect(parseEventRecommendationContent({ eventId: null, reason: "Cannot tell." })).toEqual({
      eventId: null,
      reason: "Cannot tell.",
    });
  });

  it.each([
    ["a missing reason", { eventId: "event-1" }],
    ["a missing eventId", { reason: "x" }],
    ["a numeric eventId", { eventId: 7, reason: "x" }],
    ["a non-object", "event-1"],
  ])("rejects %s", (_label, content) => {
    expect(() => parseEventRecommendationContent(content)).toThrow();
  });
});
