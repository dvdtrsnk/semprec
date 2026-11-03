import { describe, expect, it } from "vitest";
import { computeJournalSummary, JOURNAL_SUMMARY_MAX_CHARS } from "../journalSummary.js";

const PAGE_UUID = "11111111-1111-4111-8111-111111111111";

describe("computeJournalSummary (issue #1711)", () => {
  it("returns the text of a heading that starts the page", () => {
    expect(computeJournalSummary("## Cíle kvartálu\n\nZkontrolovat rozpočet")).toBe("Cíle kvartálu");
  });

  it("returns the first line of a page that has only paragraphs", () => {
    expect(computeJournalSummary("První řádek\nDruhý řádek")).toBe("První řádek");
  });

  it("uses only the first line when one paragraph contains a soft break", () => {
    expect(computeJournalSummary("First line\nSecond line")).toBe("First line");
  });

  it("does not prefer a heading that comes after other text", () => {
    expect(computeJournalSummary("Úvodní věta\n## Cíle kvartálu")).toBe("Úvodní věta");
  });

  it("strips Markdown syntax to plain text", () => {
    expect(computeJournalSummary("**Tučný** a *šikmý* [odkaz](https://example.com)")).toBe("Tučný a šikmý odkaz");
  });

  it("collapses runs of whitespace into single spaces", () => {
    expect(computeJournalSummary("Více   mezer\tzde")).toBe("Více mezer zde");
  });

  it("cuts a longer first line to 80 characters", () => {
    const summary = computeJournalSummary("a".repeat(120));
    expect(summary).toBe("a".repeat(JOURNAL_SUMMARY_MAX_CHARS));
  });

  it("counts characters as code points, so an emoji is never split", () => {
    const summary = computeJournalSummary("😀".repeat(100));
    expect(Array.from(summary ?? "")).toHaveLength(JOURNAL_SUMMARY_MAX_CHARS);
    expect(summary).toBe("😀".repeat(JOURNAL_SUMMARY_MAX_CHARS));
  });

  it("returns null for empty input", () => {
    expect(computeJournalSummary("")).toBeNull();
  });

  it("returns null for input that holds only blank lines", () => {
    expect(computeJournalSummary("\n   \n\t\n")).toBeNull();
  });

  it("passes over a page link, which has no text, to the first line that has text", () => {
    expect(computeJournalSummary(`[](semprec://page/${PAGE_UUID})\nOdstavec textu`)).toBe("Odstavec textu");
  });

  it("returns null when the only block is a page link without text", () => {
    expect(computeJournalSummary(`[](semprec://page/${PAGE_UUID})`)).toBeNull();
  });
});
