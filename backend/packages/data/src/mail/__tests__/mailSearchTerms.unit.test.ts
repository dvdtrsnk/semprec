import { describe, expect, it } from "vitest";
import { asciiFoldedMailSearchTerms, parseMailSearchTerms } from "../mailSearchTerms.js";

describe("parseMailSearchTerms", () => {
  it.each([
    ["plain words", "old offer", { include: ["old", "offer"], exclude: [] }],
    ["a quoted phrase as one term", 'the "old offer" now', { include: ["the", "old offer", "now"], exclude: [] }],
    [
      "an excluded word and phrase",
      'offer -draft -"cold call"',
      { include: ["offer"], exclude: ["draft", "cold call"] },
    ],
    ["`or` as no term", "offer or invoice OR bill", { include: ["offer", "invoice", "bill"], exclude: [] }],
    ["a quoted `or` as a term", '"or"', { include: ["or"], exclude: [] }],
    ["quotes and backslashes inside a word as spaces", 'a"b c\\d', { include: ["a b", "c d"], exclude: [] }],
    ["an unclosed quote up to the end", '"old offer', { include: ["old offer"], exclude: [] }],
    ["nothing", "  ", { include: [], exclude: [] }],
  ])("reads %s", (_name, text, terms) => {
    expect(parseMailSearchTerms(text)).toEqual(terms);
  });

  it("keeps at most eight terms of at most 100 characters", () => {
    const terms = parseMailSearchTerms(`${"x".repeat(150)} ${Array.from({ length: 10 }, (_, i) => `w${i}`).join(" ")}`);

    expect(terms.include).toHaveLength(8);
    expect(terms.include[0]).toBe("x".repeat(100));
  });
});

describe("asciiFoldedMailSearchTerms", () => {
  it("drops diacritics and other non-ASCII characters, and a term left empty", () => {
    expect(asciiFoldedMailSearchTerms({ include: ["účetní", "žluť", "日本"], exclude: ["Příliš"] })).toEqual({
      include: ["ucetni", "zlut"],
      exclude: ["Prilis"],
    });
  });
});
