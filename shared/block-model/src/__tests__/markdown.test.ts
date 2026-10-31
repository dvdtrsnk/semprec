import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BlockInputError,
  collectItemLinks,
  parseMarkdown,
  serializeBlocks,
  stripMarkdown,
  type PageBlock,
  type SerializeOptions,
  type TextRun,
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

const fixtures = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "markdown.json"), "utf8"),
) as { vectors: Vector[]; rejections: Rejection[] };

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
      expect((thrown as BlockInputError).issues).toMatchObject([{ path: rejection.path, code: rejection.code }]);
    });
  }
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

  it("sanitizes an unsafe type key when serializing", () => {
    const out = serializeBlocks([{ id: "a", type: "we ird\n-->", indent: 0, text: text("x") }]);
    expect(out).toBe("<!-- semprec:block id=a type=we_ird_--_ indent=0 -->\nx");
    expect(parseMarkdown(out)).toMatchObject([{ id: "a", type: "we_ird_--_" }]);
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
    expect(stripMarkdown(md, 100)).toBe("Title bold and a link next code");
  });

  it("truncates to maxChars code points", () => {
    expect(stripMarkdown("abcdef", 3)).toBe("abc");
    expect(stripMarkdown("a😀b", 2)).toBe("a😀");
    expect(stripMarkdown("abc", 0)).toBe("");
  });
});
