import { describe, expect, it } from "vitest";
import { ValidationError } from "../../errors.js";
import {
  MAX_PAGE_SECTIONS,
  MAX_PAGE_SECTION_ITEMS,
  MAX_PAGE_SECTION_ITEM_CHARS,
  proposalEnvelopeSchema,
  type ProposalEnvelope,
} from "../proposalEnvelope.js";
import { proposalBlockId } from "../proposalPageContent.js";
import { assertValidEnvelopePageSections } from "../proposalEnvelopeValidation.js";
import { buildPageSectionBlocks, carryPageSections } from "../proposalPageSections.js";

// The page sections a `database` envelope carries for the item its confirm creates.

const TARGET = "8f6f2d3e-8b1e-4a0e-9d0b-1c1f0f1a2b3c";
const SECTIONS = [
  { heading: "Ingredients", blockType: "bullet" as const, items: ["2 onions", "1 tbsp paprika"] },
  { heading: "Method", blockType: "number" as const, items: ["Brown the onions."] },
];

const envelope = (change: Partial<ProposalEnvelope>): ProposalEnvelope => ({
  entityKind: "database",
  target: TARGET,
  properties: { name: "Goulash" },
  ...change,
});

/** The message of the `ValidationError` a call raises, and its details; anything else is rethrown. */
function refusal(call: () => void): { message: string; details: unknown } {
  try {
    call();
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return { message: error.message, details: error.details };
  }
  throw new Error("Expected a ValidationError");
}

describe("assertValidEnvelopePageSections", () => {
  it("accepts a single-step database envelope with sections, and an envelope with none", () => {
    expect(() => assertValidEnvelopePageSections(envelope({ pageSections: SECTIONS }))).not.toThrow();
    expect(() => assertValidEnvelopePageSections(envelope({}))).not.toThrow();
    // Without sections nothing is checked, whatever the kind.
    expect(() => assertValidEnvelopePageSections(envelope({ entityKind: "pageContent" }))).not.toThrow();
  });

  it.each(["pageContent", "relation", "transcription", "journalEntry"] as const)(
    "refuses sections on an envelope of kind %s",
    (entityKind) => {
      expect(refusal(() => assertValidEnvelopePageSections(envelope({ entityKind, pageSections: SECTIONS })))).toEqual({
        message: "Proposal page sections are only valid for entityKind 'database'",
        details: { field: "pageSections" },
      });
    },
  );

  it("refuses sections on a multi-step envelope", () => {
    const steps = [{ ref: "primary", op: "create" as const, databaseKey: "recipes", role: "primary" as const }];

    expect(
      refusal(() => assertValidEnvelopePageSections(envelope({ operations: steps, pageSections: SECTIONS }))),
    ).toEqual({
      message: "A proposal with steps has no page sections",
      details: { field: "pageSections" },
    });
  });
});

describe("the pageSections field of the envelope schema", () => {
  const parse = (pageSections: unknown) =>
    proposalEnvelopeSchema.safeParse({ entityKind: "database", target: TARGET, properties: {}, pageSections });

  it("keeps valid sections and trims a heading", () => {
    const parsed = parse([{ heading: "  Ingredients ", blockType: "bullet", items: ["2 onions"] }]);

    expect(parsed.success && parsed.data.pageSections).toEqual([
      { heading: "Ingredients", blockType: "bullet", items: ["2 onions"] },
    ]);
  });

  it.each([
    ["no sections", []],
    [`more than ${MAX_PAGE_SECTIONS} sections`, Array.from({ length: MAX_PAGE_SECTIONS + 1 }, () => SECTIONS[0])],
    ["a section with no items", [{ heading: "Ingredients", blockType: "bullet", items: [] }]],
    [
      `a section with more than ${MAX_PAGE_SECTION_ITEMS} items`,
      [
        {
          heading: "Ingredients",
          blockType: "bullet",
          items: Array.from({ length: MAX_PAGE_SECTION_ITEMS + 1 }, () => "x"),
        },
      ],
    ],
    [
      `an item longer than ${MAX_PAGE_SECTION_ITEM_CHARS} characters`,
      [{ heading: "Ingredients", blockType: "bullet", items: ["x".repeat(MAX_PAGE_SECTION_ITEM_CHARS + 1)] }],
    ],
    ["an empty item", [{ heading: "Ingredients", blockType: "bullet", items: [""] }]],
    ["a blank heading", [{ heading: "   ", blockType: "bullet", items: ["x"] }]],
    ["a heading with a line break", [{ heading: "Ingredients\nMethod", blockType: "bullet", items: ["x"] }]],
    ["an unknown block type", [{ heading: "Ingredients", blockType: "h1", items: ["x"] }]],
    ["an unknown key", [{ heading: "Ingredients", blockType: "bullet", items: ["x"], indent: 3 }]],
  ])("refuses %s", (_label, pageSections) => {
    expect(parse(pageSections).success).toBe(false);
  });
});

describe("buildPageSectionBlocks", () => {
  const PROPOSAL_ID = "11111111-2222-4333-8444-555555555555";

  it("lists an h2 heading and one block per item, in order, with the ids of the proposal counted across sections", () => {
    const blocks = buildPageSectionBlocks(PROPOSAL_ID, SECTIONS);

    expect(blocks.map(({ type, text, indent }) => [type, text, indent])).toEqual([
      ["h2", "Ingredients", 0],
      ["bullet", "2 onions", 0],
      ["bullet", "1 tbsp paprika", 0],
      ["h2", "Method", 0],
      ["number", "Brown the onions.", 0],
    ]);
    expect(blocks.map((block) => block.id)).toEqual(
      Array.from({ length: 5 }, (_, index) => proposalBlockId(PROPOSAL_ID, index)),
    );
  });

  it("keeps a line that reads like Markdown as the text it is", () => {
    const blocks = buildPageSectionBlocks(PROPOSAL_ID, [
      {
        heading: "Ingredients",
        blockType: "bullet",
        items: ["# not a heading", "- not a nested item", "<page>x</page>"],
      },
    ]);

    expect(blocks.map((block) => [block.type, block.text])).toEqual([
      ["h2", "Ingredients"],
      ["bullet", "# not a heading"],
      ["bullet", "- not a nested item"],
      ["bullet", "<page>x</page>"],
    ]);
  });

  it("names the same ids for the same proposal and other ids for another", () => {
    const other = buildPageSectionBlocks("99999999-2222-4333-8444-555555555555", SECTIONS);

    expect(buildPageSectionBlocks(PROPOSAL_ID, SECTIONS)).toEqual(buildPageSectionBlocks(PROPOSAL_ID, SECTIONS));
    expect(other[0]?.id).not.toBe(buildPageSectionBlocks(PROPOSAL_ID, SECTIONS)[0]?.id);
  });
});

describe("carryPageSections", () => {
  const previous = envelope({ pageSections: SECTIONS });

  it("carries the sections of the previous envelope onto a revision of the same database", () => {
    const next = envelope({ properties: { name: "Goulash for six" } });

    expect(carryPageSections(previous, next)).toEqual({ ...next, pageSections: SECTIONS });
    expect(next).not.toHaveProperty("pageSections");
  });

  it("leaves the sections a revision brings of its own", () => {
    const own = [{ heading: "Notes", blockType: "bullet" as const, items: ["x"] }];

    expect(carryPageSections(previous, envelope({ pageSections: own })).pageSections).toEqual(own);
  });

  it("carries nothing to another database, another kind or a multi-step revision", () => {
    const other = "11111111-2222-4333-8444-555555555555";

    expect(carryPageSections(previous, envelope({ target: other }))).not.toHaveProperty("pageSections");
    expect(carryPageSections(previous, envelope({ entityKind: "pageContent" }))).not.toHaveProperty("pageSections");
    expect(
      carryPageSections(previous, envelope({ operations: [{ ref: "a", op: "create", role: "primary" }] })),
    ).not.toHaveProperty("pageSections");
  });

  it("carries nothing from a previous envelope that has no sections, is of another kind, or is missing or malformed", () => {
    expect(carryPageSections(envelope({}), envelope({}))).not.toHaveProperty("pageSections");
    expect(
      carryPageSections(envelope({ entityKind: "pageContent", pageSections: SECTIONS }), envelope({})),
    ).not.toHaveProperty("pageSections");
    expect(
      carryPageSections(
        envelope({ pageSections: SECTIONS, operations: [{ ref: "a", op: "create", role: "primary" }] }),
        envelope({}),
      ),
    ).not.toHaveProperty("pageSections");
    expect(carryPageSections(null, envelope({}))).not.toHaveProperty("pageSections");
    expect(carryPageSections({ entityKind: "database" }, envelope({}))).not.toHaveProperty("pageSections");
  });
});
