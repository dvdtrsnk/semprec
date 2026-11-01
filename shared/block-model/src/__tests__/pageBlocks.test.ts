import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  BlockInputError,
  getBlocksMap,
  getOrderArray,
  readPageBlocks,
  validateBlockInput,
  writeBlock,
} from "../index.js";

function exchange(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

function rawBlock(doc: Y.Doc, id: string, fields: Record<string, unknown>): void {
  doc.transact(() => {
    const block = new Y.Map<unknown>();
    getBlocksMap(doc).set(id, block);
    for (const [key, value] of Object.entries(fields)) {
      block.set(key, value);
    }
  });
}

describe("concurrent first insert", () => {
  it("keeps both blocks in order and converges on one order", () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.transact(() => writeBlock(a, { id: "block-a", type: "text", text: "from a" }));
    b.transact(() => writeBlock(b, { id: "block-b", type: "h1", text: "from b" }));
    exchange(a, b);

    expect(getOrderArray(a).toArray().sort()).toEqual(["block-a", "block-b"]);
    expect(getOrderArray(a).toArray()).toEqual(getOrderArray(b).toArray());
    expect(readPageBlocks(a).map((block) => block.id)).toEqual(readPageBlocks(b).map((block) => block.id));
    expect(readPageBlocks(a)).toHaveLength(2);
  });
});

describe("readPageBlocks", () => {
  it("repairs a repeated id, an unknown flavour and indent 7 without touching the doc", () => {
    const doc = new Y.Doc();
    rawBlock(doc, "b1", { "sys:id": "b1", "sys:flavour": "callout", indent: 7 });
    doc.transact(() => getOrderArray(doc).push(["b1", "b1"]));
    const before = Y.encodeStateAsUpdate(doc);

    const blocks = readPageBlocks(doc);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ id: "b1", type: "text", indent: 5, done: false, synthetic: false });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(getBlocksMap(doc).get("b1")?.get("sys:flavour")).toBe("callout");
  });

  it("treats a non-integer or negative indent as 0 or the nearest bound", () => {
    const doc = new Y.Doc();
    rawBlock(doc, "a", { "sys:flavour": "text", indent: 1.5 });
    rawBlock(doc, "b", { "sys:flavour": "text", indent: "2" });
    rawBlock(doc, "c", { "sys:flavour": "text", indent: -3 });
    expect(readPageBlocks(doc).map((block) => block.indent)).toEqual([0, 0, 0]);
  });

  it("appends a block missing from order after the ordered ones, in ascending id order", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      writeBlock(doc, { id: "m", type: "text" });
      writeBlock(doc, { id: "k", type: "text" });
    });
    rawBlock(doc, "z", { "sys:flavour": "text" });
    rawBlock(doc, "a", { "sys:flavour": "text" });

    expect(readPageBlocks(doc).map((block) => block.id)).toEqual(["m", "k", "a", "z"]);
  });

  it("skips ids in order that have no block", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      getOrderArray(doc).push(["ghost"]);
      writeBlock(doc, { id: "real", type: "text" });
    });
    expect(readPageBlocks(doc).map((block) => block.id)).toEqual(["real"]);
  });

  it("reads done only on todo blocks", () => {
    const doc = new Y.Doc();
    rawBlock(doc, "a", { "sys:flavour": "todo", done: true });
    rawBlock(doc, "b", { "sys:flavour": "bullet", done: true });
    expect(readPageBlocks(doc).map((block) => block.done)).toEqual([true, false]);
  });

  it("ignores embedded objects and malformed attributes from a remote Yjs update without writing", () => {
    const doc = new Y.Doc();
    const text = new Y.Text();
    rawBlock(doc, "a", { "sys:flavour": "text", text });
    text.insert(0, "safe", { bold: true, link: { href: 4 }, unknown: true });
    text.insertEmbed(4, { secret: "not text" });
    const before = Y.encodeStateAsUpdate(doc);
    expect(readPageBlocks(doc)[0]?.text).toEqual([{ insert: "safe", attributes: { bold: true } }]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it("reads an empty doc as one synthetic empty text block and writes nothing", () => {
    const doc = new Y.Doc();
    const before = Y.encodeStateAsUpdate(doc);

    expect(readPageBlocks(doc)).toEqual([
      { id: null, type: "text", indent: 0, done: false, text: [], pageId: null, synthetic: true },
    ]);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe("writeBlock", () => {
  it("stores text with inline attributes and reads it back", () => {
    const doc = new Y.Doc();
    doc.transact(() =>
      writeBlock(doc, {
        id: "t",
        type: "todo",
        indent: 2,
        done: true,
        text: [
          { insert: "plain " },
          { insert: "bold", attributes: { bold: true } },
          { insert: "link", attributes: { link: { href: "https://example.com" } } },
        ],
      }),
    );

    expect(readPageBlocks(doc)).toEqual([
      {
        id: "t",
        type: "todo",
        indent: 2,
        done: true,
        text: [
          { insert: "plain " },
          { insert: "bold", attributes: { bold: true } },
          { insert: "link", attributes: { link: { href: "https://example.com" } } },
        ],
        pageId: null,
        synthetic: false,
      },
    ]);
  });

  it("replaces an existing block without duplicating it in order and drops fields the new type lacks", () => {
    const doc = new Y.Doc();
    doc.transact(() => writeBlock(doc, { id: "x", type: "todo", done: true, text: "old" }));
    doc.transact(() => writeBlock(doc, { id: "x", type: "page", pageId: "p1" }));

    expect(getOrderArray(doc).toArray()).toEqual(["x"]);
    const stored = getBlocksMap(doc).get("x");
    expect(stored?.has("done")).toBe(false);
    expect(stored?.has("text")).toBe(false);
    expect(readPageBlocks(doc)[0]).toMatchObject({ type: "page", pageId: "p1", text: [], done: false });
  });

  it("replaces the text of an existing block", () => {
    const doc = new Y.Doc();
    doc.transact(() => writeBlock(doc, { id: "x", type: "text", text: "old" }));
    doc.transact(() => writeBlock(doc, { id: "x", type: "text", text: "new" }));
    expect(readPageBlocks(doc)[0]?.text).toEqual([{ insert: "new" }]);
  });

  it("refuses invalid input and leaves the doc untouched", () => {
    const doc = new Y.Doc();
    const before = Y.encodeStateAsUpdate(doc);
    expect(() => Reflect.apply(writeBlock, undefined, [doc, { id: "x", type: "nope" }])).toThrow(BlockInputError);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe("validateBlockInput", () => {
  const codes = (input: unknown): string[] => validateBlockInput(input).map((issue) => issue.code);

  it("accepts valid blocks of every shape", () => {
    expect(validateBlockInput({ id: "a", type: "text" })).toEqual([]);
    expect(validateBlockInput({ id: "a", type: "todo", done: false, indent: 5, text: "x" })).toEqual([]);
    expect(validateBlockInput({ id: "a", type: "page", pageId: "p" })).toEqual([]);
  });

  it("rejects an unknown type key", () => {
    expect(codes({ id: "a", type: "callout" })).toEqual(["unknown_type"]);
  });

  it.each([7, -1, 1.5, "2", null])("rejects indent %s", (indent) => {
    expect(codes({ id: "a", type: "text", indent })).toEqual(["invalid_indent"]);
  });

  it("rejects done on a non-todo and a non-boolean done on a todo", () => {
    expect(codes({ id: "a", type: "bullet", done: true })).toEqual(["done_not_allowed"]);
    expect(codes({ id: "a", type: "todo", done: "yes" })).toEqual(["invalid_done"]);
  });

  it("rejects pageId on a non-page and a missing pageId on a page", () => {
    expect(codes({ id: "a", type: "text", pageId: "p" })).toEqual(["page_id_not_allowed"]);
    expect(codes({ id: "a", type: "page" })).toEqual(["page_id_required"]);
    expect(codes({ id: "a", type: "page", pageId: 3 })).toEqual(["invalid_page_id"]);
  });

  it("rejects text on a page block and malformed text", () => {
    expect(codes({ id: "a", type: "page", pageId: "p", text: "x" })).toEqual(["text_not_allowed"]);
    expect(codes({ id: "a", type: "text", text: 5 })).toEqual(["invalid_text"]);
    expect(codes({ id: "a", type: "text", text: [{ insert: 1 }] })).toEqual(["invalid_text"]);
    expect(codes({ id: "a", type: "text", text: [{ insert: "x", attributes: { underline: true } }] })).toEqual([
      "invalid_text",
    ]);
    expect(codes({ id: "a", type: "text", text: [{ insert: "x", attributes: { link: {} } }] })).toEqual([
      "invalid_text",
    ]);
  });

  it("rejects a missing id and non-object input without throwing", () => {
    expect(codes({ type: "text" })).toEqual(["invalid_id"]);
    expect(codes(null)).toEqual(["not_an_object"]);
    expect(codes("text")).toEqual(["not_an_object"]);
  });
});
