/**
 * Keyword matching of project mail signals that tolerates Czech inflection without a dictionary.
 *
 * Each word of a keyword is lower-cased and stripped of diacritics (the search vector's `unaccent` does the same to
 * the indexed text). A word of fewer than `MIN_STEM_LENGTH` letters, or one holding a digit, must match a word of the
 * text exactly. Any other word loses the longest of `CZECH_ENDINGS` whose removal still leaves `MIN_STEM_LENGTH`
 * letters (at most one ending, none when none fits) and matches every word of the text that starts with what is left:
 * `faktura`, `faktury`, `fakturou` and `fakturách` all become `faktur:*`, `Novák`, `Nováka` and `Novákovi` all
 * become `novak:*`. A keyword of several words matches them as a phrase, in order and adjacent. Changes of the stem
 * itself (`Praha` and `v Praze`) are not covered.
 */

export const MIN_STEM_LENGTH = 4;

/**
 * Case and number endings of Czech nouns, adjectives and surnames, without diacritics. Longest first, so `ovi` is
 * removed rather than `i`. `ova` is missing on purpose: `Nováková` is not `Novák`.
 */
export const CZECH_ENDINGS: readonly string[] = [
  "ach",
  "ami",
  "ech",
  "eho",
  "emi",
  "emu",
  "ich",
  "imi",
  "imu",
  "ove",
  "ovi",
  "ych",
  "ymi",
  "ymu",
  "am",
  "em",
  "im",
  "ou",
  "um",
  "ym",
  "a",
  "e",
  "i",
  "o",
  "u",
  "y",
];

export interface KeywordTerm {
  /** Lower case, without diacritics, only letters and digits. */
  word: string;
  prefix: boolean;
}

function foldWord(word: string): string {
  return word.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function stemKeywordWord(raw: string): KeywordTerm {
  const word = foldWord(raw);
  if (word.length < MIN_STEM_LENGTH || /\p{N}/u.test(word)) return { word, prefix: false };
  const ending = CZECH_ENDINGS.find(
    (candidate) => word.endsWith(candidate) && word.length - candidate.length >= MIN_STEM_LENGTH,
  );
  return { word: ending ? word.slice(0, word.length - ending.length) : word, prefix: true };
}

/** The words of a keyword, as the search parser splits text: runs of letters and digits. */
export function keywordTerms(keyword: string): KeywordTerm[] {
  return (keyword.match(/[\p{L}\p{N}]+/gu) ?? []).map(stemKeywordWord).filter((term) => term.word !== "");
}

/**
 * One `to_tsquery` text for the `czech_simple` configuration matching any of the keywords, or `null` when none has a
 * word. Built only from letters, digits and the operators `:*`, `<->` and `|`, so it cannot be malformed; it is bound
 * as a parameter, never spliced into SQL.
 */
export function keywordTsQuery(keywords: readonly string[]): string | null {
  const phrases = keywords
    .map((keyword) =>
      keywordTerms(keyword)
        .map((term) => (term.prefix ? `${term.word}:*` : term.word))
        .join(" <-> "),
    )
    .filter((phrase) => phrase !== "");
  return phrases.length === 0 ? null : phrases.map((phrase) => `(${phrase})`).join(" | ");
}
