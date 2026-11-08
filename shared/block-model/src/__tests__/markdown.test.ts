import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  BlockInputError,
  collectItemLinks,
  parseMarkdown,
  serializeBlocks,
  serializeInline,
  stripMarkdown,
  readPageBlocks,
  writeBlock,
  type PageBlock,
  type SerializeOptions,
  type TextRun,
  type InlineAttributes,
} from "../index.js";

interface VectorBlock {
  id?: string;
  type: string;
  indent?: number;
  done?: boolean;
  text?: TextRun[];
  pageId?: string;
}

interface Vector {
  name: string;
  markdown: string;
  blocks: VectorBlock[];
  direction?: "both" | "parse" | "serialize";
  canonical?: string;
  withIds?: boolean;
  synthetic?: boolean;
  pageTitles?: Record<string, string>;
}

interface Rejection {
  name: string;
  markdown: string;
  parseOptions: { allowPage: boolean };
  path: string;
  code: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inlineAttributes(value: unknown): value is InlineAttributes {
  if (!record(value)) return false;
  return Object.entries(value).every(([key, entry]) => {
    if (key === "link") return record(entry) && typeof entry.href === "string";
    return (key === "bold" || key === "italic" || key === "code") && entry === true;
  });
}

function vectorBlock(value: unknown): value is VectorBlock {
  if (!record(value) || typeof value.type !== "string") return false;
  return (
    (value.id === undefined || typeof value.id === "string") &&
    (value.indent === undefined || typeof value.indent === "number") &&
    (value.done === undefined || typeof value.done === "boolean") &&
    (value.pageId === undefined || typeof value.pageId === "string") &&
    (value.text === undefined ||
      (Array.isArray(value.text) &&
        value.text.every(
          (run: unknown) =>
            record(run) &&
            typeof run.insert === "string" &&
            (run.attributes === undefined || inlineAttributes(run.attributes)),
        )))
  );
}

function vector(value: unknown): value is Vector {
  if (!record(value)) return false;
  return (
    typeof value.name === "string" &&
    typeof value.markdown === "string" &&
    Array.isArray(value.blocks) &&
    value.blocks.every(vectorBlock) &&
    (value.direction === undefined ||
      value.direction === "both" ||
      value.direction === "parse" ||
      value.direction === "serialize") &&
    (value.canonical === undefined || typeof value.canonical === "string") &&
    (value.withIds === undefined || typeof value.withIds === "boolean") &&
    (value.synthetic === undefined || typeof value.synthetic === "boolean") &&
    (value.pageTitles === undefined ||
      (record(value.pageTitles) && Object.values(value.pageTitles).every((title) => typeof title === "string")))
  );
}

function rejection(value: unknown): value is Rejection {
  return (
    record(value) &&
    typeof value.name === "string" &&
    typeof value.markdown === "string" &&
    record(value.parseOptions) &&
    typeof value.parseOptions.allowPage === "boolean" &&
    typeof value.path === "string" &&
    typeof value.code === "string"
  );
}

const rawFixtures: unknown = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "markdown.json"), "utf8"),
);
if (
  !record(rawFixtures) ||
  !Array.isArray(rawFixtures.vectors) ||
  !rawFixtures.vectors.every(vector) ||
  !Array.isArray(rawFixtures.rejections) ||
  !rawFixtures.rejections.every(rejection)
) {
  throw new Error("Invalid Markdown fixture file");
}
const fixtures = { vectors: rawFixtures.vectors, rejections: rawFixtures.rejections };

function expectedBlocks(vector: Vector): unknown[] {
  return vector.blocks.map((block, index) => ({
    id: block.id ?? `b${index + 1}`,
    type: block.type,
    indent: block.indent ?? 0,
    ...(block.type === "todo" ? { done: block.done ?? false } : {}),
    ...(block.type === "page" ? { pageId: block.pageId } : { text: block.text ?? [] }),
  }));
}

function serializable(vector: Vector): Array<Omit<PageBlock, "type"> & { type: string }> {
  return vector.blocks.map((block, index) => ({
    id: vector.synthetic ? null : (block.id ?? `b${index + 1}`),
    type: block.type,
    indent: block.indent ?? 0,
    done: block.done ?? false,
    text: block.text ?? [],
    pageId: block.pageId ?? null,
    synthetic: vector.synthetic === true,
  }));
}

function serializeOptions(vector: Vector): SerializeOptions {
  return {
    withIds: vector.withIds === true,
    resolvePageTitle: (pageId) => vector.pageTitles?.[pageId] ?? "",
  };
}

describe("markdown fixtures", () => {
  it("loads a nonempty set of uniquely named vectors and rejections", () => {
    expect(fixtures.vectors.length).toBeGreaterThan(0);
    expect(fixtures.rejections.length).toBeGreaterThan(0);
    const names = [...fixtures.vectors, ...fixtures.rejections].map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const vector of fixtures.vectors) {
    const direction = vector.direction ?? "both";
    it(vector.name, () => {
      if (direction !== "serialize") {
        expect(parseMarkdown(vector.markdown)).toEqual(expectedBlocks(vector));
        // Round trip: what the parser reads serializes back to the canonical form.
        const canonical = vector.canonical ?? vector.markdown;
        const reserialized = serializeBlocks(parseMarkdown(vector.markdown), serializeOptions(vector));
        expect(reserialized).toBe(canonical);
        expect(parseMarkdown(canonical)).toEqual(expectedBlocks(vector));
        expect(serializeBlocks(parseMarkdown(canonical), serializeOptions(vector))).toBe(canonical);
      }
      if (direction !== "parse") {
        expect(serializeBlocks(serializable(vector), serializeOptions(vector))).toBe(vector.markdown);
      }
    });
  }

  for (const rejection of fixtures.rejections) {
    it(rejection.name, () => {
      let thrown: unknown;
      try {
        parseMarkdown(rejection.markdown, rejection.parseOptions);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(BlockInputError);
      if (!(thrown instanceof BlockInputError)) throw new Error("Expected BlockInputError");
      expect(thrown.issues).toMatchObject([{ path: rejection.path, code: rejection.code }]);
    });
  }
});

describe("lossless canonical inline content", () => {
  it.each(
    (
      [
        [{ insert: "\n", attributes: { code: true } }],
        [{ insert: "a\nb", attributes: { code: true } }],
        [{ insert: "\na\n\n", attributes: { code: true } }],
        [{ insert: "a", attributes: { code: true } }, { insert: "\n" }, { insert: "b", attributes: { code: true } }],
        [{ insert: "\n", attributes: { code: true, bold: true, italic: true, link: { href: "https://example.com" } } }],
        [{ insert: "<br> <code><br></code>", attributes: { code: true } }],
        [{ insert: "<code><br></code>" }],
      ] satisfies TextRun[][]
    ).map((text) => [text] as const),
  )("preserves code and plain LF attributes in Y.Text %#", (text) => {
    const doc = new Y.Doc();
    writeBlock(doc, { id: "source", type: "text", text });
    const blocks = readPageBlocks(doc);
    for (const withIds of [false, true]) {
      const markdown = serializeBlocks(blocks, { withIds });
      const parsed = parseMarkdown(markdown);
      expect(parsed[0]).toMatchObject({ type: "text", text: blocks[0]?.text });
      expect(serializeBlocks(parsed, { withIds })).toBe(markdown);
    }
  });

  it.each(["\r", "\u2028", "\u2029"])("preserves interior %j in structural blocks and code", (separator) => {
    const doc = new Y.Doc();
    const text: TextRun[] = [
      { insert: `A${separator}B`, attributes: { bold: true } },
      { insert: `C${separator}D`, attributes: { code: true } },
    ];
    writeBlock(doc, { id: "heading", type: "h2", text });
    writeBlock(doc, { id: "quote", type: "quote", text });
    writeBlock(doc, { id: "list", type: "bullet", indent: 2, text });
    const blocks = readPageBlocks(doc);
    const markdown = serializeBlocks(blocks, { withIds: true });
    const parsed = parseMarkdown(markdown);
    expect(parsed.map(({ id, type, indent, text: runs }) => ({ id, type, indent, text: runs }))).toEqual(
      blocks.map(({ id, type, indent, text: runs }) => ({ id, type, indent, text: runs })),
    );
    expect(serializeBlocks(parsed, { withIds: true })).toBe(markdown);
    expect(parseMarkdown("  \n\n# ordinary\n\n  - item").map((block) => block.type)).toEqual(["h1", "bullet"]);
    expect(parseMarkdown("# heading\r\n\r\n  - item\r\n").map((block) => block.type)).toEqual(["h1", "bullet"]);
  });

  it("retains a code break in a preserved unknown block", () => {
    const text: TextRun[] = [{ insert: "a\nb", attributes: { code: true } }];
    const markdown = serializeBlocks([{ id: "x", type: "future-kind", indent: 0, text }], { withIds: true });
    expect(parseMarkdown(markdown)[0]).toMatchObject({ id: "x", type: "future-kind", text });
    expect(serializeBlocks(parseMarkdown(markdown), { withIds: true })).toBe(markdown);
  });

  it.each([false, true])("preserves an actual Y.Text page link with ids=%s and either page policy", (withIds) => {
    const doc = new Y.Doc();
    const text: TextRun[] = [{ insert: " [Title] ", attributes: { bold: true, link: { href: "semprec://page/p1" } } }];
    writeBlock(doc, { id: "source", type: "text", text });
    const blocks = readPageBlocks(doc);
    expect(blocks[0]?.text).toEqual(text);
    const markdown = serializeBlocks(blocks, { withIds });
    expect(markdown).toContain("(<semprec://page/p1>)");
    for (const allowPage of [false, true]) {
      const parsed = parseMarkdown(markdown, { allowPage });
      expect(parsed[0]).toMatchObject({ type: "text", text });
      expect(serializeBlocks(parsed, { withIds })).toBe(markdown);
    }
    expect(stripMarkdown(markdown, 100)).toContain("[Title]");
  });

  it.each([false, true])("roundtrips destination LFs and literal references in Y.Text with ids=%s", (withIds) => {
    const cases = [
      ["https://\nleading", "https://&#xa;leading"],
      ["https://a\nb", "https://a&#xa;b"],
      ["https://trailing\n", "https://trailing&#xa;"],
      ["semprec://page/a\n\nb", "semprec://page/a&#xa;&#xa;b"],
      ["semprec://page/&#xa;", "semprec://page/\\&#xa;"],
      ["semprec://page/\\&#xa;\n<end>", "semprec://page/\\\\\\&#xa;&#xa;\\<end\\>"],
      ["https://a/(x)&#xA;&#x0a;&#10;", "https://a/(x)&#xA;&#x0a;&#10;"],
    ] as const;
    for (const [href, encoded] of cases) {
      const doc = new Y.Doc();
      const text: TextRun[] = [{ insert: "[Title]", attributes: { bold: true, italic: true, link: { href } } }];
      writeBlock(doc, { id: "source", type: "text", text });
      const markdown = serializeBlocks(readPageBlocks(doc), { withIds });
      expect(markdown).toContain(`(<${encoded}>)`);
      expect(markdown.split("\n").filter((line) => !line.startsWith("<!--"))).toHaveLength(1);
      for (const allowPage of [false, true]) {
        const parsed = parseMarkdown(markdown, { allowPage });
        expect(parsed[0]).toMatchObject({ type: "text", text });
        expect(serializeBlocks(parsed, { withIds })).toBe(markdown);
      }
    }
    const bare = "[Plain](https://example.com/&#xa;)";
    expect(serializeBlocks(parseMarkdown(bare))).toBe(bare);
    expect(parseMarkdown("`&#xa;`")[0]?.text).toEqual([{ insert: "&#xa;", attributes: { code: true } }]);
  });

  it.each([false, true])("preserves opaque page IDs from real Yjs blocks with ids=%s", (withIds) => {
    const ids = [
      "p1",
      "7c3c4df0-9ec4-40cb-8a31-4b87a39e8731",
      " ",
      "a b",
      "\nstart",
      "end\n",
      "a\n\nb",
      "a\rb\tc\u2028\u2029",
      "a(b)c",
      "\\u0041",
      "%20&#xa;",
      "\0[<]",
      "ž😀",
      "\ud800",
      "\udc00",
    ];
    for (const pageId of ids) {
      const doc = new Y.Doc();
      writeBlock(doc, { id: "source", type: "page", pageId });
      const resolver = () => "Title";
      const markdown = serializeBlocks(readPageBlocks(doc), { withIds, resolvePageTitle: resolver });
      expect(markdown.split("\n").filter((line) => !line.startsWith("<!--"))).toHaveLength(1);
      const parsed = parseMarkdown(markdown, { allowPage: true });
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({ type: "page", pageId });
      expect(parsed[0]?.text).toBeUndefined();
      expect(serializeBlocks(parsed, { withIds, resolvePageTitle: resolver })).toBe(markdown);
      expect(() => parseMarkdown(markdown, { allowPage: false })).toThrow(BlockInputError);
    }
    expect(serializeBlocks([{ id: "x", type: "page", indent: 0, pageId: "p1" }])).toBe("[](semprec://page/p1)");
    expect(parseMarkdown("[](semprec://page/\\u005Cu0041)")[0]?.pageId).toBe("\\u0041");
    expect(parseMarkdown("[](semprec://page/\\u00e9)")[0]?.pageId).toBe("\\u00e9");
    expect(parseMarkdown("[](semprec://page/%20)")[0]?.pageId).toBe("%20");
  });

  it.each([false, true])("keeps resolver captions on a single page line with ids=%s", (withIds) => {
    const captions = ["\n", "First\nSecond", "a\rb\u2028c\u2029d", "[brackets] `code` <br> *bold* \\ tail"];
    for (const title of captions) {
      const doc = new Y.Doc();
      writeBlock(doc, { id: "source", type: "page", pageId: "a b" });
      const resolver = () => title;
      const markdown = serializeBlocks(readPageBlocks(doc), { withIds, resolvePageTitle: resolver });
      expect(markdown.split("\n").filter((line) => !line.startsWith("<!--"))).toHaveLength(1);
      const parsed = parseMarkdown(markdown);
      expect(parsed[0]).toMatchObject({ type: "page", pageId: "a b" });
      expect(parsed[0]?.text).toBeUndefined();
      expect(serializeBlocks(parsed, { withIds, resolvePageTitle: resolver })).toBe(markdown);
      expect(stripMarkdown(markdown, 100)).toBe(title.replace(/\s+/g, " ").trim());
    }
  });

  it("keeps page links inline in preserved unknown types and alongside other text", () => {
    const text: TextRun[] = [
      { insert: "Page", attributes: { link: { href: "semprec://page/p1" } } },
      { insert: " and " },
      { insert: "web", attributes: { link: { href: "https://example.com" } } },
    ];
    const source = [{ id: "x", type: "future-kind", indent: 0, text }];
    const markdown = serializeBlocks(source, { withIds: true });
    expect(markdown).toContain("[Page](<semprec://page/p1>) and [web](https://example.com)");
    expect(parseMarkdown(markdown, { allowPage: false })[0]).toMatchObject({ type: "future-kind", text });
    expect(serializeBlocks(parseMarkdown(markdown), { withIds: true })).toBe(markdown);
    expect(parseMarkdown("[Title](semprec://page/p1)")[0]).toMatchObject({ type: "page", pageId: "p1" });
    expect(() => parseMarkdown("[Title](semprec://page/p1)", { allowPage: false })).toThrow(BlockInputError);
  });

  it.each([
    ["text", 0],
    ["quote", 0],
    ["h2", 0],
    ["bullet", 2],
    ["unknown-kind", 0],
  ] as const)("preserves boundary whitespace in %s", (type, indent) => {
    const text: TextRun[] = [
      { insert: " \t", attributes: { italic: true } },
      { insert: "A", attributes: { link: { href: "https://example.com" } } },
      { insert: "\r\u2003" },
    ];
    const doc = new Y.Doc();
    if (type === "unknown-kind") {
      const markdown = serializeBlocks([{ id: "x", type, indent, text }], { withIds: true });
      expect(parseMarkdown(markdown)[0]).toMatchObject({ type, indent, text });
      expect(serializeBlocks(parseMarkdown(markdown), { withIds: true })).toBe(markdown);
      return;
    }
    writeBlock(doc, { id: "x", type, indent, text });
    const markdown = serializeBlocks(readPageBlocks(doc), { withIds: true });
    expect(parseMarkdown(markdown)[0]).toMatchObject({ type, indent, text });
    expect(serializeBlocks(parseMarkdown(markdown), { withIds: true })).toBe(markdown);
  });

  it.each([" a ", " a", "a ", "  ", "&#x20;"])("preserves literal code %j", (value) => {
    const text: TextRun[] = [{ insert: value, attributes: { code: true } }];
    const markdown = serializeBlocks([{ id: "x", type: "text", indent: 0, text }]);
    expect(parseMarkdown(markdown)[0]?.text).toEqual(text);
    expect(serializeBlocks(parseMarkdown(markdown))).toBe(markdown);
  });

  it("does not decode invalid, noncanonical, non-whitespace or escaped references", () => {
    const literal = "&#x20; \\&#x9; &#x020; &#xA; &#x61; &#x110000;";
    const markdown = serializeBlocks([{ id: "x", type: "text", indent: 0, text: [{ insert: literal }] }]);
    expect(parseMarkdown(markdown)[0]?.text).toEqual([{ insert: literal }]);
    expect(parseMarkdown("&#x23; heading")[0]).toMatchObject({ type: "text", text: [{ insert: "&#x23; heading" }] });
    expect(parseMarkdown("&#x20;# heading")[0]).toMatchObject({ type: "text", text: [{ insert: " # heading" }] });
    expect(parseMarkdown("   \n\n")).toEqual([]);
  });
});

describe("markdown behaviour", () => {
  const text = (insert: string): TextRun[] => [{ insert }];

  it("parses a page link line when pages are allowed by default", () => {
    expect(parseMarkdown("[T](semprec://page/p1)")).toMatchObject([{ type: "page", pageId: "p1" }]);
  });

  it("writes an empty page title when no resolver is given", () => {
    const block: PageBlock = {
      id: "a",
      type: "page",
      indent: 0,
      done: false,
      text: [],
      pageId: "p1",
      synthetic: false,
    };
    expect(serializeBlocks([block])).toBe("[](semprec://page/p1)");
  });

  it("separates blocks with a blank line except between adjacent list items", () => {
    const blocks = [
      { id: "a", type: "bullet", indent: 0, text: text("a") },
      { id: "b", type: "number", indent: 0, text: text("b") },
      { id: "c", type: "text", indent: 0, text: text("c") },
      { id: "d", type: "bullet", indent: 0, text: text("d") },
    ];
    expect(serializeBlocks(blocks)).toBe("- a\n1. b\n\nc\n\n- d");
  });

  it("keeps ids from comments, never repeats one and skips used generated ids", () => {
    const parsed = parseMarkdown(
      "<!-- semprec:block id=b1 type=text indent=0 -->\none\n\n<!-- semprec:block id=b1 type=text indent=0 -->\ntwo\n\nthree",
    );
    expect(parsed.map((block) => block.id)).toEqual(["b1", "b2", "b3"]);
  });

  it("uses createId for blocks without an id comment", () => {
    let n = 0;
    const ids = parseMarkdown("a\n\nb", { createId: () => `x${(n += 1)}` }).map((block) => block.id);
    expect(ids).toEqual(["x1", "x2"]);
  });

  it("ignores a type key in a comment that is not a plain key", () => {
    expect(parseMarkdown("<!-- semprec:block id=a type=a/b indent=0 -->\nhi")).toMatchObject([
      { id: "a", type: "text" },
    ]);
  });

  it("does not let a comment change the type of a marker line", () => {
    expect(parseMarkdown("<!-- semprec:block id=a type=callout indent=0 -->\n## Title")).toMatchObject([
      { type: "h2" },
    ]);
  });

  it("preserves distinct actual Yjs block IDs through emitted comments", () => {
    const ids = ["a b", "a_b", "x:1", "a\\u0041", '-->=\\"', "x\ny", "ž😀", "\ud800"];
    const doc = new Y.Doc();
    for (const [index, id] of ids.entries()) {
      writeBlock(doc, index % 2 === 0 ? { id, type: "text", text: text("x") } : { id, type: "page", pageId: "p1" });
    }
    const blocks = readPageBlocks(doc);
    const markdown = serializeBlocks(blocks, { withIds: true });
    expect(markdown).toContain("id=a\\u0020b");
    expect(markdown).toContain("id=a_b");
    expect(markdown).toContain("id=x:1");
    const parsed = parseMarkdown(markdown);
    expect(parsed.map((block) => block.id)).toEqual(blocks.map((block) => block.id));
    expect(parsed.map((block) => block.type)).toEqual(blocks.map((block) => block.type));
    expect(serializeBlocks(parsed, { withIds: true })).toBe(markdown);
    const withoutIds = serializeBlocks([{ id: "a b", type: "text", indent: 0, text: text("x") }]);
    expect(withoutIds).toBe("x");
    expect(parseMarkdown(withoutIds)[0]?.id).toBe("b1");
    const duplicates = parseMarkdown(
      "<!-- semprec:block id=a type=text indent=0 -->\nx\n\n<!-- semprec:block id=\\u0061 type=text indent=0 -->\ny",
    );
    expect(duplicates.map((block) => block.id)).toEqual(["a", "b1"]);
  });

  it("preserves arbitrary public unknown types without permitting comment injection", () => {
    for (const type of ["we ird", "we_ird", "", " ", "\0", '\"\"', "a\n--> type=page", "\\u0041", "ž😀", "\ud800"]) {
      const block = { id: "a", type, indent: 0, text: text("x") };
      for (const withIds of [false, true]) {
        const markdown = serializeBlocks([block], { withIds });
        expect(markdown.split("\n")).toHaveLength(2);
        expect(parseMarkdown(markdown)).toMatchObject([block]);
        expect(serializeBlocks(parseMarkdown(markdown), { withIds })).toBe(markdown);
      }
    }
    expect(serializeBlocks([{ id: "a", type: "", indent: 0, text: text("x") }])).toContain('type=\"\"');
    const empty = serializeBlocks([{ id: "a", type: "", indent: 0, text: [] }]);
    expect(parseMarkdown(empty)).toMatchObject([{ id: "a", type: "", text: [] }]);
    expect(serializeBlocks(parseMarkdown(empty))).toBe(empty);
    expect(parseMarkdown("<!-- semprec:block id=a type=we\\u0020ird indent=0 -->\n## Title")[0]?.type).toBe("h2");
  });

  it("round-trips text that looks like a marker or markup", () => {
    for (const insert of ["1. x", "# x", "> x", "- [ ] x", "+ x", "a\n# x", "**x**", "<br>", "1.5 liters"]) {
      const out = serializeBlocks([{ id: "b1", type: "text", indent: 0, text: text(insert) }]);
      expect(parseMarkdown(out), out).toEqual([{ id: "b1", type: "text", indent: 0, text: text(insert) }]);
    }
  });
});

describe("collectItemLinks", () => {
  const ID = "3f2b8c1e-5a47-4d0b-9c61-7e2a1b9d4f10";
  const OTHER = "aaaaaaaa-5a47-4d0b-9c61-7e2a1b9d4f11";

  it("returns distinct well-formed ids in order of first appearance, lower-cased", () => {
    const md = `[A](semprec://items/${OTHER})\n\n[B](semprec://items/${ID.toUpperCase()}) and [C](semprec://items/${ID})\n\n[D](semprec://items/${OTHER})`;
    expect(collectItemLinks(parseMarkdown(md))).toEqual({ ids: [OTHER, ID], malformed: false });
  });

  it("flags a malformed item id and ignores other links", () => {
    const md = "[A](semprec://items/not-a-uuid) [B](https://example.com) [C](semprec://page/p-1)";
    expect(collectItemLinks(parseMarkdown(md))).toEqual({ ids: [], malformed: true });
    expect(collectItemLinks(parseMarkdown("[B](https://example.com)"))).toEqual({ ids: [], malformed: false });
  });

  it("does not change the parsed blocks: the link stays plain content", () => {
    const blocks = parseMarkdown(`[Standup](semprec://items/${ID})`);
    expect(blocks).toMatchObject([
      { type: "text", text: [{ insert: "Standup", attributes: { link: { href: `semprec://items/${ID}` } } }] },
    ]);
  });
});

describe("stripMarkdown", () => {
  it("reduces markers, emphasis, links and breaks to plain text", () => {
    const md = "## Title\n\n- **bold** and [a link](https://e.com)<br>next\n- [x] `code`\n\n[Page](semprec://page/p1)";
    expect(stripMarkdown(md, 100)).toBe("Title bold and a link next code Page");
  });

  it("retains escaped page-link labels without changing the page model", () => {
    const md = "[Roadmap \\[draft\\]](semprec://page/p1)";
    expect(stripMarkdown(md, 100)).toBe("Roadmap [draft]");
    expect(parseMarkdown(md)).toMatchObject([{ type: "page", pageId: "p1" }]);
    expect(parseMarkdown(md)[0]).not.toHaveProperty("text");
    expect(stripMarkdown("[](semprec://page/p1)", 100)).toBe("");
    expect(stripMarkdown("[Page](semprec://page/p1)\r\nnext", 100)).toBe("Page next");
  });

  it("truncates to maxChars code points", () => {
    expect(stripMarkdown("abcdef", 3)).toBe("abc");
    expect(stripMarkdown("a😀b", 2)).toBe("a😀");
    expect(stripMarkdown("abc", 0)).toBe("");
  });
});

describe("canonical inline export", () => {
  it("retains existing inline formatting and escaping", () => {
    expect(serializeInline([{ insert: "Bold", attributes: { bold: true } }, { insert: " & plain" }])).toBe(
      "**Bold** & plain",
    );
  });
});
