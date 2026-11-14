import { describe, expect, it } from "vitest";
import { deriveApprovalCardKind, deriveInboxCardKind, type InboxCardKindInput } from "../inboxCardKind.js";
import type { ProposalEnvelope } from "../inboxTickAction.js";
import { parseStoredProposalEnvelope } from "../proposalEnvelope.js";

const database: ProposalEnvelope = { entityKind: "database", target: "db-1", properties: {} };
const pageContent: ProposalEnvelope = { entityKind: "pageContent", target: "page-1", properties: {} };
const speakerRelation: ProposalEnvelope = {
  entityKind: "relation",
  target: "item-1",
  properties: { propertyKey: "speakers" },
};
const eventRelation: ProposalEnvelope = {
  entityKind: "relation",
  target: "item-1",
  properties: { propertyKey: "event" },
};

function input(overrides: Partial<InboxCardKindInput>): InboxCardKindInput {
  return { kind: "inbox", status: "proposed", envelope: database, ownerModuleId: "tasks", ...overrides };
}

describe("deriveInboxCardKind", () => {
  it.each([
    ["tasks", "task"],
    ["events", "event"],
    ["projects", "project"],
    ["areas", "area"],
    ["companies", "company"],
    ["people", "person"],
    ["healthRecords", "health"],
    ["files", "file"],
  ] as const)("maps database module %s to %s", (ownerModuleId, expected) => {
    expect(deriveInboxCardKind(input({ ownerModuleId }))).toEqual({ cardKind: expected, baseKind: expected });
  });

  it("derives page content by page ownership even on a transcript card", () => {
    expect(deriveInboxCardKind(input({ kind: "transcript", envelope: pageContent, ownerModuleId: "journal" }))).toEqual(
      {
        cardKind: "journal",
        baseKind: "journal",
      },
    );
    expect(deriveInboxCardKind(input({ kind: "transcript", envelope: pageContent, ownerModuleId: null }))).toEqual({
      cardKind: "page",
      baseKind: "page",
    });
  });

  it.each([
    ["journal", "journal"],
    ["pages", "page"],
    [null, "page"],
  ] as const)("maps a pageContent envelope owned by %s to %s", (ownerModuleId, expected) => {
    expect(deriveInboxCardKind(input({ envelope: pageContent, ownerModuleId }))).toEqual({
      cardKind: expected,
      baseKind: expected,
    });
  });

  it("derives transcript cards from the envelope role", () => {
    expect(deriveInboxCardKind(input({ kind: "transcript", envelope: speakerRelation, ownerModuleId: null }))).toEqual({
      cardKind: "speaker",
      baseKind: "speaker",
    });
    expect(deriveInboxCardKind(input({ kind: "transcript", envelope: eventRelation, ownerModuleId: null }))).toEqual({
      cardKind: "transcriptEvent",
      baseKind: "event",
    });
    expect(deriveInboxCardKind(input({ kind: "transcript", ownerModuleId: "events" }))).toEqual({
      cardKind: "transcriptEvent",
      baseKind: "event",
    });
  });

  it.each([null, "futureModule", "tasks"])("falls back for a transcript database with owner %s", (ownerModuleId) => {
    expect(deriveInboxCardKind(input({ kind: "transcript", ownerModuleId }))).toEqual({
      cardKind: "clarify",
      baseKind: "page",
    });
    expect(deriveInboxCardKind(input({ kind: "transcript", status: "invalid", ownerModuleId }))).toEqual({
      cardKind: "invalid",
      baseKind: "page",
    });
  });

  it("derives a thread task card with a Tasks envelope as a task, also while invalid", () => {
    expect(deriveInboxCardKind(input({ kind: "mailThread" }))).toEqual({ cardKind: "task", baseKind: "task" });
    expect(deriveInboxCardKind(input({ kind: "mailThread", status: "invalid" }))).toEqual({
      cardKind: "invalid",
      baseKind: "task",
    });
  });

  it.each(["events", "pages", null])(
    "falls back for a thread task card whose database has owner %s",
    (ownerModuleId) => {
      expect(deriveInboxCardKind(input({ kind: "mailThread", ownerModuleId }))).toEqual({
        cardKind: "clarify",
        baseKind: "page",
      });
    },
  );

  it("falls back for a thread task card whose envelope is not a database envelope", () => {
    for (const envelope of [pageContent, eventRelation]) {
      expect(deriveInboxCardKind(input({ kind: "mailThread", envelope, ownerModuleId: "tasks" }))).toEqual({
        cardKind: "clarify",
        baseKind: "page",
      });
    }
  });

  it("derives clarify for needsClarification regardless of the envelope", () => {
    expect(deriveInboxCardKind(input({ status: "needsClarification" }))).toEqual({
      cardKind: "clarify",
      baseKind: "clarify",
    });
  });

  it("derives invalid with the editable baseKind, or invalid without an envelope", () => {
    expect(deriveInboxCardKind(input({ status: "invalid" }))).toEqual({ cardKind: "invalid", baseKind: "task" });
    expect(deriveInboxCardKind(input({ status: "invalid", envelope: null, ownerModuleId: null }))).toEqual({
      cardKind: "invalid",
      baseKind: "invalid",
    });
  });

  it.each(["computing", "computeFailed"])("derives a %s card from its envelope, or clarify without one", (status) => {
    expect(deriveInboxCardKind(input({ status }))).toEqual({ cardKind: "task", baseKind: "task" });
    expect(deriveInboxCardKind(input({ status, envelope: null, ownerModuleId: null }))).toEqual({
      cardKind: "clarify",
      baseKind: "clarify",
    });
  });

  it("falls back to clarify without throwing on an unknown module or entity kind", () => {
    expect(deriveInboxCardKind(input({ ownerModuleId: "futureModule" }))).toEqual({
      cardKind: "clarify",
      baseKind: "page",
    });
    expect(deriveInboxCardKind(input({ ownerModuleId: null }))).toEqual({ cardKind: "clarify", baseKind: "page" });
    const unknownEnvelope = parseStoredProposalEnvelope({ entityKind: "future", target: "x", properties: {} }, "p1");
    for (const kind of ["inbox", "transcript", "mailThread"] as const) {
      expect(deriveInboxCardKind(input({ kind, envelope: unknownEnvelope }))).toEqual({
        cardKind: "clarify",
        baseKind: "page",
      });
      expect(deriveInboxCardKind(input({ kind, status: "invalid", envelope: unknownEnvelope }))).toEqual({
        cardKind: "invalid",
        baseKind: "page",
      });
    }
    for (const ownerModuleId of ["constructor", "toString", "__proto__"]) {
      expect(deriveInboxCardKind(input({ ownerModuleId }))).toEqual({ cardKind: "clarify", baseKind: "page" });
    }
    expect(deriveInboxCardKind(input({ envelope: speakerRelation }))).toEqual({
      cardKind: "clarify",
      baseKind: "page",
    });
  });

  it("is pure: the same input gives the same output and the input is not mutated", () => {
    const value = input({});
    const snapshot = structuredClone(value);
    expect(deriveInboxCardKind(value)).toEqual(deriveInboxCardKind(value));
    expect(value).toEqual(snapshot);
  });

  it("derives an approval request", () => {
    expect(deriveApprovalCardKind()).toEqual({ cardKind: "approval", baseKind: "approval" });
  });
});
