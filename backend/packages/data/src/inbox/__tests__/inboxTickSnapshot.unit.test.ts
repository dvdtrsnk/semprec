import { describe, expect, it } from "vitest";
import type { ItemRow } from "../../types.js";
import { tickComputationInput, type TickSnapshot } from "../inboxTickSnapshot.js";

// Issue gh-1987: the state of the card being recomputed travels with the computation input.

function row(id: string, properties: Record<string, unknown>): ItemRow {
  return {
    id,
    databaseId: "00000000-0000-4000-8000-000000000001",
    properties,
    computed: {},
    createdAt: "2026-10-16T08:12:00Z",
    updatedAt: "2026-10-16T08:12:00Z",
    deletedAt: null,
  };
}

function snapshot(existingProposal: ItemRow | null): TickSnapshot {
  return {
    sourceTypeId: null,
    item: row("item", { text: "Buy milk" }),
    type: null,
    processingMethod: "database",
    entityKind: "database",
    existingProposal,
    fingerprint: "fp",
    locale: "cs",
  };
}

const PROJECT_ITEM_ID = "00000000-0000-4000-8000-0000000000aa";

describe("tickComputationInput previousProposal", () => {
  it("has none for a first computation, which has no card", () => {
    const input = tickComputationInput(snapshot(null), PROJECT_ITEM_ID);
    expect(input).not.toHaveProperty("previousProposal");
    expect(input.projectItemId).toBe(PROJECT_ITEM_ID);
  });

  it("carries the aiProposal, history and userEditedKeys of the existing card", () => {
    const aiProposal = { entityKind: "database", properties: { name: "Buy milk" } };
    const history = [{ author: "ai", message: "Created a proposal for the source item." }];
    const card = row("card", { aiProposal, history, userEditedKeys: ["primary.name"], status: "proposed" });

    expect(tickComputationInput(snapshot(card), PROJECT_ITEM_ID).previousProposal).toEqual({
      aiProposal,
      history,
      userEditedKeys: ["primary.name"],
    });
  });

  it("keeps an empty list of edited keys, which says the person edited nothing", () => {
    const card = row("card", { userEditedKeys: [] });
    expect(tickComputationInput(snapshot(card), PROJECT_ITEM_ID).previousProposal).toEqual({ userEditedKeys: [] });
  });

  it("leaves out each part that is absent or null", () => {
    const card = row("card", { aiProposal: null, history: [{ author: "ai", message: "m" }] });
    expect(tickComputationInput(snapshot(card), PROJECT_ITEM_ID).previousProposal).toEqual({
      history: [{ author: "ai", message: "m" }],
    });
  });

  it("has none for a card that holds none of the three parts", () => {
    const card = row("card", { status: "computing", aiProposal: null, userEditedKeys: null });
    expect(tickComputationInput(snapshot(card), PROJECT_ITEM_ID)).not.toHaveProperty("previousProposal");
  });
});
