import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  BlockInputError,
  BlockOperationError,
  deleteBlocks,
  duplicateBlocks,
  getBlocksMap,
  getOrderArray,
  insertBlocks,
  mergeBlocks,
  moveBlocks,
  readPageBlocks,
  setIndent,
  setType,
  splitBlock,
  writeBlock,
  type BlockInput,
} from "../index.js";

function exchange(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

function docWith(...blocks: BlockInput[]): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => blocks.forEach((block) => writeBlock(doc, block)));
  return doc;
}

function clone(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

const ids = (doc: Y.Doc): Array<string | null> => readPageBlocks(doc).map((block) => block.id);

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(BlockOperationError);
    if (!(error instanceof BlockOperationError)) throw new Error("Expected BlockOperationError", { cause: error });
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("insertBlocks", () => {
  it("inserts in order after the block, assigns ids and runs in one transaction", () => {
    const doc = docWith({ id: "a", type: "text" }, { id: "b", type: "text" });
    let transactions = 0;
    doc.on("afterTransaction", () => (transactions += 1));
    const created = insertBlocks(
      doc,
      "a",
      [
        { type: "h1", text: "x" },
        { id: "n", type: "bullet" },
      ],
      "origin",
    );
    expect(transactions).toBe(1);
    expect(created[1]).toBe("n");
    expect(ids(doc)).toEqual(["a", created[0], "n", "b"]);
  });

  it("inserts at the start, refuses unknown afterId, existing ids and invalid blocks", () => {
    const doc = docWith({ id: "a", type: "text" });
    insertBlocks(doc, null, [{ id: "z", type: "text" }]);
    expect(ids(doc)).toEqual(["z", "a"]);
    expectCode(() => insertBlocks(doc, "nope", [{ type: "text" }]), "invalid_after_id");
    expectCode(() => insertBlocks(doc, null, [{ id: "a", type: "text" }]), "duplicate_block_id");
    expectCode(
      () =>
        insertBlocks(doc, null, [
          { id: "d", type: "text" },
          { id: "d", type: "text" },
        ]),
      "duplicate_block_id",
    );
    expect(() => insertBlocks(doc, null, [{ type: "page" }])).toThrow();
    expect(ids(doc)).toEqual(["z", "a"]);
  });

  it("materializes the first real block of an empty document", () => {
    const doc = new Y.Doc();
    expect(readPageBlocks(doc)[0]?.synthetic).toBe(true);
    insertBlocks(doc, null, [{ id: "first", type: "text", text: "hi" }]);
    expect(ids(doc)).toEqual(["first"]);
    expectCode(() => insertBlocks(new Y.Doc(), "x", [{ type: "text" }]), "invalid_after_id");
  });

  it("keeps both blocks in the same order after concurrent inserts after the same block", () => {
    const a = docWith({ id: "base", type: "text" });
    const b = clone(a);
    insertBlocks(a, "base", [{ id: "from-a", type: "text" }]);
    insertBlocks(b, "base", [{ id: "from-b", type: "text" }]);
    exchange(a, b);
    expect(ids(a)).toEqual(ids(b));
    expect([...ids(a)].sort()).toEqual(["base", "from-a", "from-b"]);
    expect(ids(a)[0]).toBe("base");
  });
});

describe("splitBlock", () => {
  it.each([
    ["italic", { italic: true }],
    ["code", { code: true }],
    ["link", { link: { href: "https://example.com" } }],
  ] as const)("keeps %s attributes on both sides of the split", (_name, attributes) => {
    const doc = docWith({ id: "t", type: "text", text: [{ insert: "abcd", attributes }] });
    splitBlock(doc, "t", 2);
    expect(readPageBlocks(doc).map((block) => block.text)).toEqual([
      [{ insert: "ab", attributes }],
      [{ insert: "cd", attributes }],
    ]);
  });

  it("keeps bold on both parts, type and indent, and resets done", () => {
    const doc = docWith({
      id: "t",
      type: "todo",
      indent: 2,
      done: true,
      text: [{ insert: "hello world", attributes: { bold: true } }],
    });
    const newId = splitBlock(doc, "t", 5);
    const [first, second] = readPageBlocks(doc);
    expect(second?.id).toBe(newId);
    expect(first?.text).toEqual([{ insert: "hello", attributes: { bold: true } }]);
    expect(second?.text).toEqual([{ insert: " world", attributes: { bold: true } }]);
    expect(second).toMatchObject({ type: "todo", indent: 2, done: false });
    expect(first?.done).toBe(true);
  });

  it("refuses page blocks and offsets outside the text", () => {
    const doc = docWith({ id: "p", type: "page", pageId: "x" }, { id: "t", type: "text", text: "ab" });
    expectCode(() => splitBlock(doc, "p", 0), "page_block_not_splittable");
    expectCode(() => splitBlock(doc, "t", 3), "offset_out_of_range");
    expectCode(() => splitBlock(doc, "t", -1), "offset_out_of_range");
    expect(ids(doc)).toEqual(["p", "t"]);
  });
});

describe("mergeBlocks", () => {
  it("appends text with attributes to the earlier block, which keeps its type", () => {
    const doc = docWith(
      { id: "a", type: "h1", indent: 1, text: [{ insert: "one", attributes: { bold: true } }] },
      { id: "b", type: "bullet", text: [{ insert: "two" }, { insert: "x", attributes: { italic: true } }] },
    );
    mergeBlocks(doc, "b");
    expect(readPageBlocks(doc)).toMatchObject([
      {
        id: "a",
        type: "h1",
        indent: 1,
        text: [
          { insert: "one", attributes: { bold: true } },
          { insert: "two" },
          { insert: "x", attributes: { italic: true } },
        ],
      },
    ]);
    expect(getBlocksMap(doc).has("b")).toBe(false);
  });

  it("fails on page blocks and on the first block and changes nothing", () => {
    const doc = docWith({ id: "t", type: "text" }, { id: "p", type: "page", pageId: "x" }, { id: "u", type: "text" });
    const before = Y.encodeStateAsUpdate(doc);
    expectCode(() => mergeBlocks(doc, "p"), "page_block_not_mergeable");
    expectCode(() => mergeBlocks(doc, "u"), "page_block_not_mergeable");
    expectCode(() => mergeBlocks(doc, "t"), "no_previous_block");
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe("moveBlocks", () => {
  it("places non-adjacent blocks after the target in their document order", () => {
    const doc = docWith(...["a", "b", "c", "d", "e", "f", "g"].map((id): BlockInput => ({ id, type: "text" })));
    moveBlocks(doc, ["e", "a", "c"], "f");
    expect(ids(doc)).toEqual(["b", "d", "f", "a", "c", "e", "g"]);
    moveBlocks(doc, ["g"], null);
    expect(ids(doc)[0]).toBe("g");
  });

  it("refuses an afterId among the moved ids or unknown", () => {
    const doc = docWith({ id: "a", type: "text" }, { id: "b", type: "text" });
    expectCode(() => moveBlocks(doc, ["a"], "a"), "invalid_after_id");
    expectCode(() => moveBlocks(doc, ["a"], "zz"), "invalid_after_id");
    expectCode(() => moveBlocks(doc, ["zz"], null), "block_not_found");
  });

  it("leaves a concurrently moved block once when read and deleteBlocks removes every occurrence", () => {
    const a = docWith(...["a", "b", "c", "d"].map((id): BlockInput => ({ id, type: "text" })));
    const b = clone(a);
    moveBlocks(a, ["a"], "b");
    moveBlocks(b, ["a"], "c");
    exchange(a, b);
    expect(
      getOrderArray(a)
        .toArray()
        .filter((id) => id === "a"),
    ).toHaveLength(2);
    expect(ids(a).filter((id) => id === "a")).toHaveLength(1);
    expect(ids(a)).toEqual(ids(b));

    deleteBlocks(a, ["a"]);
    expect(getOrderArray(a).toArray()).not.toContain("a");
    expect(ids(a)).toEqual(["b", "c", "d"]);
  });
});

describe("setType", () => {
  it("rejects an unknown runtime type without mutating the document", () => {
    const doc = docWith({ id: "t", type: "todo", done: true });
    const before = Y.encodeStateAsUpdate(doc);
    // @ts-expect-error Exercise the JavaScript boundary with an invalid type.
    expect(() => setType(doc, ["t"], "unknown")).toThrow(BlockInputError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("resets done when a todo becomes text and drops done", () => {
    const doc = docWith({ id: "t", type: "todo", done: true });
    setType(doc, ["t"], "text");
    expect(readPageBlocks(doc)[0]).toMatchObject({ type: "text", done: false });
    expect(getBlocksMap(doc).get("t")?.has("done")).toBe(false);
    setType(doc, ["t"], "todo");
    expect(readPageBlocks(doc)[0]).toMatchObject({ type: "todo", done: false });
  });

  it("resets done on a todo set to todo and refuses page conversions", () => {
    const doc = docWith({ id: "t", type: "todo", done: true }, { id: "p", type: "page", pageId: "x" });
    expectCode(() => setType(doc, ["t", "p"], "text"), "page_conversion_required");
    expectCode(() => setType(doc, ["t"], "page"), "page_conversion_required");
    expect(readPageBlocks(doc)[0]?.done).toBe(true);
    setType(doc, ["t"], "todo");
    expect(readPageBlocks(doc)[0]?.done).toBe(false);
  });
});

describe("setIndent", () => {
  it("clamps to 0..5", () => {
    const doc = docWith({ id: "a", type: "text", indent: 4 }, { id: "b", type: "text", indent: 1 });
    setIndent(doc, ["a", "b"], 3);
    expect(readPageBlocks(doc).map((block) => block.indent)).toEqual([5, 4]);
    setIndent(doc, ["a", "b"], -9);
    expect(readPageBlocks(doc).map((block) => block.indent)).toEqual([0, 0]);
    expectCode(() => setIndent(doc, ["a"], 0.5), "invalid_delta");
  });
});

describe("duplicateBlocks", () => {
  it("inserts copies after the last selected block keeping text, attributes and order", () => {
    const doc = docWith(
      { id: "a", type: "text", text: [{ insert: "A", attributes: { code: true } }] },
      { id: "b", type: "text" },
      { id: "c", type: "todo", done: true, text: "C" },
    );
    const copies = duplicateBlocks(doc, ["c", "a"]);
    const blocks = readPageBlocks(doc);
    expect(blocks.map((block) => block.id)).toEqual(["a", "b", "c", copies[0], copies[1]]);
    expect(blocks[3]?.text).toEqual([{ insert: "A", attributes: { code: true } }]);
    expect(blocks[4]).toMatchObject({ type: "todo", done: true, text: [{ insert: "C" }] });
    expect(new Set(blocks.map((block) => block.id)).size).toBe(5);
  });

  it("refuses page blocks", () => {
    const doc = docWith({ id: "p", type: "page", pageId: "x" });
    expectCode(() => duplicateBlocks(doc, ["p"]), "page_conversion_required");
    expect(ids(doc)).toEqual(["p"]);
  });
});

describe("deleteBlocks", () => {
  it("leaves one empty text block when everything is deleted", () => {
    const doc = docWith({ id: "a", type: "h1", text: "x" }, { id: "b", type: "text" });
    deleteBlocks(doc, ["a", "b"]);
    const blocks = readPageBlocks(doc);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "text", text: [], synthetic: false });
    expect(getOrderArray(doc).toArray()).toHaveLength(1);
    expect(getBlocksMap(doc).size).toBe(1);
  });
});

describe("order tidying", () => {
  it.each([
    ["insert", (doc: Y.Doc) => insertBlocks(doc, null, [])],
    ["move", (doc: Y.Doc) => moveBlocks(doc, [], null)],
    ["type", (doc: Y.Doc) => setType(doc, [], "text")],
    ["indent", (doc: Y.Doc) => setIndent(doc, [], 1)],
    ["duplicate", (doc: Y.Doc) => duplicateBlocks(doc, [])],
    ["delete", (doc: Y.Doc) => deleteBlocks(doc, [])],
  ])("keeps empty %s input a no-write operation", (_name, operation) => {
    const doc = docWith({ id: "a", type: "text" });
    doc.transact(() => getOrderArray(doc).push(["a"]));
    const before = Y.encodeStateAsUpdate(doc);
    operation(doc);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(getOrderArray(doc).toArray()).toEqual(["a", "a"]);

    const empty = new Y.Doc();
    const emptyBefore = Y.encodeStateAsUpdate(empty);
    operation(empty);
    expect(Y.encodeStateAsUpdate(empty)).toEqual(emptyBefore);
    expect(readPageBlocks(empty)[0]?.synthetic).toBe(true);
  });

  it("still validates invalid arguments for an empty operation", () => {
    const doc = new Y.Doc();
    expectCode(() => insertBlocks(doc, "missing", []), "invalid_after_id");
    expectCode(() => moveBlocks(doc, [], "missing"), "invalid_after_id");
    expectCode(() => setIndent(doc, [], 0.5), "invalid_delta");
    // @ts-expect-error Exercise the JavaScript boundary with an invalid type.
    expect(() => setType(doc, [], "unknown")).toThrow(BlockInputError);
  });

  it.each([
    ["insert", (doc: Y.Doc) => insertBlocks(doc, "a", [{ id: "new", type: "text" }], "test")],
    ["split", (doc: Y.Doc) => splitBlock(doc, "a", 0, "test")],
    ["merge", (doc: Y.Doc) => mergeBlocks(doc, "b", "test")],
    ["move", (doc: Y.Doc) => moveBlocks(doc, ["a"], "c", "test")],
    ["type", (doc: Y.Doc) => setType(doc, ["a"], "h1", "test")],
    ["indent", (doc: Y.Doc) => setIndent(doc, ["a"], 1, "test")],
    ["duplicate", (doc: Y.Doc) => duplicateBlocks(doc, ["a"], "test")],
    ["delete", (doc: Y.Doc) => deleteBlocks(doc, ["a"], "test")],
  ])("tidies duplicates in the same transaction as %s", (_name, operation) => {
    const doc = docWith({ id: "a", type: "text" }, { id: "b", type: "text" }, { id: "c", type: "text" });
    doc.transact(() => getOrderArray(doc).push(["a", "b"]));
    const origins: unknown[] = [];
    doc.on("afterTransaction", (transaction) => origins.push(transaction.origin));
    operation(doc);
    const order = getOrderArray(doc).toArray();
    expect(new Set(order).size).toBe(order.length);
    expect(origins).toEqual(["test"]);
  });

  it("drops repeated ids on write", () => {
    const doc = docWith({ id: "a", type: "text" }, { id: "b", type: "text" });
    doc.transact(() => getOrderArray(doc).push(["a", "b"]));
    setIndent(doc, ["a"], 1);
    expect(getOrderArray(doc).toArray()).toEqual(["a", "b"]);
  });
});
