import { describe, expect, it } from "vitest";
import type { PageBlock, TextRun } from "@semprec/block-model";
import { MAX_DIFF_CELLS, planBlockDiff, type DiffNewBlock } from "../docs/pageBlockDiff.js";

const PAGE_ID = "11111111-1111-4111-8111-111111111111";

function current(id: string, text: string, extra: Partial<PageBlock> = {}): PageBlock {
  return {
    id,
    type: "text",
    indent: 0,
    done: false,
    text: text === "" ? [] : [{ insert: text }],
    pageId: null,
    synthetic: false,
    ...extra,
  };
}

function next(id: string, text: string | TextRun[], extra: Partial<DiffNewBlock> = {}): DiffNewBlock {
  return { id, type: "text", text, ...extra };
}

/** The ids a diff leaves in place, in the order it names them, for readable expectations. */
function summary(diff: ReturnType<typeof planBlockDiff>) {
  return {
    insertions: diff.insertions.map(({ afterId, blocks }) => ({ afterId, ids: blocks.map((block) => block.id) })),
    deleteIds: diff.deleteIds,
  };
}

describe("planBlockDiff (issue #1765)", () => {
  it("plans nothing for a body whose blocks are all unchanged", () => {
    const diff = planBlockDiff([current("a", "One"), current("b", "Two")], [next("x", "One"), next("y", "Two")]);
    expect(summary(diff)).toEqual({ insertions: [], deleteIds: [] });
  });

  it("replaces only the changed paragraph in the middle and keeps the blocks around it", () => {
    const diff = planBlockDiff(
      [current("a", "One"), current("b", "Two"), current("c", "Three")],
      [next("x", "One"), next("y", "Two, reworded"), next("z", "Three")],
    );
    expect(summary(diff)).toEqual({ insertions: [{ afterId: "a", ids: ["y"] }], deleteIds: ["b"] });
  });

  it("inserts at the start with a null anchor and at the end after the last kept block", () => {
    const diff = planBlockDiff([current("a", "Middle")], [next("x", "Start"), next("y", "Middle"), next("z", "End")]);
    expect(summary(diff)).toEqual({
      insertions: [
        { afterId: null, ids: ["x"] },
        { afterId: "a", ids: ["z"] },
      ],
      deleteIds: [],
    });
  });

  it("groups consecutive new blocks into one insertion and anchors the next run on the block before it", () => {
    const diff = planBlockDiff(
      [current("a", "Keep one"), current("b", "Drop"), current("c", "Keep two")],
      [next("x", "Keep one"), next("y", "New one"), next("z", "New two"), next("w", "Keep two"), next("v", "Tail")],
    );
    expect(summary(diff)).toEqual({
      insertions: [
        { afterId: "a", ids: ["y", "z"] },
        { afterId: "c", ids: ["v"] },
      ],
      deleteIds: ["b"],
    });
  });

  it("deletes the blocks the new body no longer has", () => {
    const diff = planBlockDiff([current("a", "One"), current("b", "Two"), current("c", "Three")], [next("x", "Two")]);
    expect(summary(diff)).toEqual({ insertions: [], deleteIds: ["a", "c"] });
  });

  describe("where a deleted block's place lies afterwards (placeAfter)", () => {
    function places(diff: ReturnType<typeof planBlockDiff>) {
      return Object.fromEntries(diff.placeAfter);
    }

    it("names the block that replaced a reworded block", () => {
      const diff = planBlockDiff(
        [current("a", "Intro"), current("b", "Outro")],
        [next("x", "Intro, reworded"), next("y", "Outro")],
      );
      expect(places(diff)).toEqual({ a: "x" });
    });

    it("names the block before the stretch when nothing replaces the deleted block, and null at the start", () => {
      const middle = planBlockDiff(
        [current("a", "One"), current("b", "Two"), current("c", "Three")],
        [next("x", "One"), next("y", "Three")],
      );
      expect(places(middle)).toEqual({ b: "a" });
      const start = planBlockDiff([current("a", "One"), current("b", "Two")], [next("x", "Two")]);
      expect(places(start)).toEqual({ a: null });
    });

    it("pairs the n-th deleted block of a stretch with the n-th new block of it, and the last one when the stretch is shorter", () => {
      const diff = planBlockDiff(
        [current("a", "Keep"), current("b", "Old one"), current("c", "Old two"), current("d", "Old three")],
        [next("w", "Keep"), next("x", "New one"), next("y", "New two")],
      );
      expect(places(diff)).toEqual({ b: "x", c: "y", d: "y" });
    });

    it("has an entry for every deleted block and for no other", () => {
      const diff = planBlockDiff(
        [current("a", "One"), current("b", "Two"), current("c", "Three"), current("d", "Four")],
        [next("x", "One"), next("y", "Three, reworded"), next("z", "Four")],
      );
      expect([...diff.placeAfter.keys()].sort()).toEqual([...diff.deleteIds].sort());
    });
  });

  it("pairs the longest common run of a changed stretch, so a block moved down is the only one inserted", () => {
    const diff = planBlockDiff(
      [current("a", "A"), current("b", "B"), current("c", "C"), current("d", "D")],
      [next("w", "B"), next("x", "C"), next("y", "D"), next("z", "A")],
    );
    expect(summary(diff)).toEqual({ insertions: [{ afterId: "d", ids: ["z"] }], deleteIds: ["a"] });
  });

  it("pairs each repeated block once, in order", () => {
    const diff = planBlockDiff(
      [current("a", "Same"), current("b", "Same")],
      [next("x", "Same"), next("y", "Same"), next("z", "Same")],
    );
    expect(summary(diff)).toEqual({ insertions: [{ afterId: "b", ids: ["z"] }], deleteIds: [] });
  });

  it.each<[string, PageBlock, DiffNewBlock]>([
    ["the type", current("a", "Text"), next("x", "Text", { type: "h1" })],
    ["the indent", current("a", "Text", { type: "bullet" }), next("x", "Text", { type: "bullet", indent: 1 })],
    [
      "the checkbox",
      current("a", "Text", { type: "todo", done: false }),
      next("x", "Text", { type: "todo", done: true }),
    ],
    [
      "the formatting",
      current("a", "Text"),
      next("x", [{ insert: "Text", attributes: { bold: true } }] satisfies TextRun[]),
    ],
  ])("treats a change of %s as a different block", (_what, before, after) => {
    const diff = planBlockDiff([before], [after]);
    expect(summary(diff)).toEqual({ insertions: [{ afterId: null, ids: ["x"] }], deleteIds: ["a"] });
  });

  it("treats the same text in runs split differently, and a block of the same content under another id, as unchanged", () => {
    const split: PageBlock = current("a", "", { text: [{ insert: "Hel" }, { insert: "lo" }] });
    const diff = planBlockDiff([split], [next("x", "Hello")]);
    expect(summary(diff)).toEqual({ insertions: [], deleteIds: [] });
  });

  it("pairs a block that survives between unmatched ends", () => {
    const before = [current("a", "A"), current("b", "B"), current("c", "C")];
    const after = [next("x", "X"), next("b2", "B"), next("y", "Y")];
    expect(summary(planBlockDiff(before, after))).toEqual({
      insertions: [
        { afterId: null, ids: ["x"] },
        { afterId: "b", ids: ["y"] },
      ],
      deleteIds: ["a", "c"],
    });
  });

  describe("page blocks", () => {
    const pageBlock = (id: string, caption: string, pageId = PAGE_ID): PageBlock =>
      current(id, caption, { type: "page", pageId });
    const pageLink = (id: string, caption: string, pageId = PAGE_ID): DiffNewBlock => ({
      id,
      type: "page",
      pageId,
      text: caption,
    });

    it("keeps a page block with the same page and caption, whatever the case of the page id", () => {
      const diff = planBlockDiff([pageBlock("a", "Checklist")], [pageLink("x", "Checklist", PAGE_ID.toUpperCase())]);
      expect(summary(diff)).toEqual({ insertions: [], deleteIds: [] });
    });

    it("replaces a page block whose caption or page changed", () => {
      expect(summary(planBlockDiff([pageBlock("a", "Checklist")], [pageLink("x", "Renamed")]))).toEqual({
        insertions: [{ afterId: null, ids: ["x"] }],
        deleteIds: ["a"],
      });
      expect(
        summary(
          planBlockDiff(
            [pageBlock("a", "Checklist")],
            [pageLink("x", "Checklist", "22222222-2222-4222-8222-222222222222")],
          ),
        ),
      ).toEqual({ insertions: [{ afterId: null, ids: ["x"] }], deleteIds: ["a"] });
    });
  });

  describe("an emptied page", () => {
    it("plans nothing when the body is empty and the page holds only the empty block an emptied page keeps", () => {
      expect(summary(planBlockDiff([current("a", "")], []))).toEqual({ insertions: [], deleteIds: [] });
    });

    it("deletes every block for an empty body, and the placeholder when the body has blocks", () => {
      expect(summary(planBlockDiff([current("a", "One"), current("b", "Two")], []))).toEqual({
        insertions: [],
        deleteIds: ["a", "b"],
      });
      expect(summary(planBlockDiff([current("a", "One")], []))).toEqual({ insertions: [], deleteIds: ["a"] });
      expect(summary(planBlockDiff([current("a", "")], [next("x", "Written")]))).toEqual({
        insertions: [{ afterId: null, ids: ["x"] }],
        deleteIds: ["a"],
      });
    });

    it("does not take an empty block with an indent, or any other empty block among several, for the placeholder", () => {
      expect(summary(planBlockDiff([current("a", "", { indent: 1 })], []))).toEqual({
        insertions: [],
        deleteIds: ["a"],
      });
      expect(summary(planBlockDiff([current("a", ""), current("b", "")], []))).toEqual({
        insertions: [],
        deleteIds: ["a", "b"],
      });
    });

    it("plans one insertion for a page that has no blocks", () => {
      expect(summary(planBlockDiff([], [next("x", "One"), next("y", "Two")]))).toEqual({
        insertions: [{ afterId: null, ids: ["x", "y"] }],
        deleteIds: [],
      });
    });
  });

  describe("a changed stretch past the comparison budget", () => {
    const size = Math.floor(Math.sqrt(MAX_DIFF_CELLS)) + 2;

    it("still pairs the blocks at both ends and replaces the whole stretch between them", () => {
      const before = [
        current("first", "First"),
        ...Array.from({ length: size }, (_, index) => current(`old-${index}`, `old ${index}`)),
        current("last", "Last"),
      ];
      const after = [
        next("n-first", "First"),
        ...Array.from({ length: size }, (_, index) => next(`new-${index}`, `new ${index}`)),
        next("n-last", "Last"),
      ];

      const diff = planBlockDiff(before, after);

      expect(diff.insertions).toHaveLength(1);
      expect(diff.insertions[0]?.afterId).toBe("first");
      expect(diff.insertions[0]?.blocks).toHaveLength(size);
      expect(diff.deleteIds).toHaveLength(size);
      expect(diff.deleteIds).not.toContain("first");
      expect(diff.deleteIds).not.toContain("last");
    });
  });
});
