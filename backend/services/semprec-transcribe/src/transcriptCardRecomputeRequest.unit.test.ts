import { describe, expect, it } from "vitest";
import type { TranscriptCardRecomputeSnapshot } from "@semprec/data";
import {
  buildTranscriptCardRecomputeRequest,
  parseTranscriptCardRecomputeContent,
} from "./transcriptCardRecomputeRequest.js";

const PERSON_ID = "11111111-1111-4111-8111-111111111111";

function snapshot(overrides: Partial<TranscriptCardRecomputeSnapshot> = {}): TranscriptCardRecomputeSnapshot {
  return {
    proposalId: "22222222-2222-4222-8222-222222222222",
    instructionEntryId: "33333333-3333-4333-8333-333333333333",
    instruction: 'it was "the accountant" call',
    aiVersion: 1,
    role: "event",
    current: { entityKind: "database", target: "events-db", properties: { name: "Planning call", timeFrom: "13:10" } },
    relationProperties: { propertyKey: "event" },
    editedFields: ["timeFrom"],
    choices: [
      { id: PERSON_ID, name: "Accountant call", details: { date: "2024-03-01", times: "13:30-14:00" }, current: false },
      { id: "series@2024-03-01", name: null, details: {}, current: true },
    ],
    transcript: {
      displayName: "Planning call",
      notes: { title: "Sprint planning", summary: "A summary.", shortSummary: "Short." },
    },
    locale: "cs",
    ...overrides,
  };
}

describe("buildTranscriptCardRecomputeRequest (issue gh-1940)", () => {
  it("asks the gateway operation without a project, at temperature 0, for the user's language", () => {
    const request = buildTranscriptCardRecomputeRequest(snapshot());

    expect(request).toMatchObject({ projectItemId: null, operation: "transcript_card_recompute", temperature: 0 });
    expect(request.system).toContain("(cs)");
    expect(request.responseSchema).toMatchObject({
      required: ["entityKind", "target", "properties", "explicitlyChangedKeys", "reason"],
      additionalProperties: false,
    });
  });

  it("carries the instruction as a JSON string, the notes, the current proposal, the edited fields and every choice", () => {
    const [message] = buildTranscriptCardRecomputeRequest(snapshot()).messages;
    const content = typeof message?.content === "string" ? message.content : "";

    expect(content).toContain(JSON.stringify('it was "the accountant" call'));
    expect(content).toContain("Recording: Planning call");
    expect(content).toContain("Title: Sprint planning\nSummary: A summary.\nShort summary: Short.");
    expect(content).toContain('Current proposal: {"entityKind":"database","target":"events-db"');
    expect(content).toContain("Fields the user edited by hand: timeFrom");
    expect(content).toContain(`- id: ${PERSON_ID}\n  name: Accountant call\n  date: 2024-03-01\n  times: 13:30-14:00`);
    expect(content).toContain("- id: series@2024-03-01 (the card proposes this one now)\n  name: unknown");
    expect(content).toContain("Properties of a relation for this card: " + JSON.stringify({ propertyKey: "event" }));
  });

  it("says so when there are no notes, no proposal, no edited fields, no choices and no name", () => {
    const [message] = buildTranscriptCardRecomputeRequest(
      snapshot({
        current: null,
        editedFields: [],
        choices: [],
        role: "speaker",
        transcript: { displayName: null, notes: null },
      }),
    ).messages;
    const content = typeof message?.content === "string" ? message.content : "";

    expect(content).toContain("Recording: unnamed\nMeeting notes:\nnone");
    expect(content).toContain("Current proposal: none");
    expect(content).toContain("Fields the user edited by hand: none");
    expect(content).toContain("Targets you may choose:\nnone");
    expect(content).toContain("A speaker card");
  });
});

describe("parseTranscriptCardRecomputeContent (issue gh-1940)", () => {
  const answer = {
    entityKind: "relation",
    target: PERSON_ID,
    properties: { propertyKey: "event" },
    explicitlyChangedKeys: [],
    reason: "Done.",
  };

  it("reads a well-formed answer", () => {
    expect(parseTranscriptCardRecomputeContent(answer)).toEqual(answer);
  });

  it("reads the answer that names no target as such", () => {
    const unsatisfiable = { ...answer, entityKind: null, target: null, properties: {} };

    expect(parseTranscriptCardRecomputeContent(unsatisfiable)).toEqual(unsatisfiable);
  });

  it.each([
    ["a kind without a target", { ...answer, target: null }],
    ["a target without a kind", { ...answer, entityKind: null }],
    ["a kind this task does not answer with", { ...answer, entityKind: "pageContent" }],
    ["an empty target", { ...answer, target: "" }],
    ["a missing reason", { ...answer, reason: undefined }],
    ["keys that are not strings", { ...answer, explicitlyChangedKeys: [1] }],
    ["content that is not an object", "relation"],
    ["null", null],
  ])("answers null for %s", (_name, content) => {
    expect(parseTranscriptCardRecomputeContent(content)).toBeNull();
  });
});
