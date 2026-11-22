import { describe, expect, it } from "vitest";
import { keywordTsQuery, stemKeywordWord } from "../mailSignalKeywords.js";

describe("the Czech keyword stem rule of project mail signals", () => {
  it.each([
    // One stem for the forms of a noun, so a keyword in any of them matches the others.
    ["faktura", "faktur"],
    ["faktury", "faktur"],
    ["fakturou", "faktur"],
    ["fakturách", "faktur"],
    ["fakturami", "faktur"],
    ["smlouva", "smlouv"],
    ["smlouvy", "smlouv"],
    ["smlouvě", "smlouv"],
    ["smlouvou", "smlouv"],
    // A surname: the base form keeps its last letter, the inflected forms lose their ending.
    ["Novák", "novak"],
    ["Nováka", "novak"],
    ["Novákovi", "novak"],
    ["Novákem", "novak"],
    // Without diacritics the same.
    ["fakturach", "faktur"],
    // An ending that would leave fewer than four letters stays.
    ["Brno", "brno"],
    ["auto", "auto"],
    // `ova` is no ending: a woman's surname does not become her husband's.
    ["Nováková", "novakov"],
  ])("stems %s to the prefix %s", (word, stem) => {
    expect(stemKeywordWord(word)).toEqual({ word: stem, prefix: true });
  });

  it.each([
    ["ČEZ", "cez"],
    ["IT", "it"],
    ["2024", "2024"],
    ["Q4faktura", "q4faktura"],
  ])("matches %s exactly: too short or holding a digit", (word, exact) => {
    expect(stemKeywordWord(word)).toEqual({ word: exact, prefix: false });
  });

  it.each([
    [["faktura"], "(faktur:*)"],
    [["zálohová faktura"], "(zalohov:* <-> faktur:*)"],
    [["Novák", "ČEZ"], "(novak:*) | (cez)"],
    [["  smlouva - o dílo!  "], "(smlouv:* <-> o <-> dilo:*)"],
    [["'&|!:*()"], null],
    [[], null],
  ])("builds the query of %j as %s", (keywords, query) => {
    expect(keywordTsQuery(keywords)).toBe(query);
  });
});
