import { ValidationError } from "../errors.js";

/** The longest page title, in Unicode code points. */
export const PAGE_TITLE_MAX_LENGTH = 500;

/** A run of line breaks, including the Unicode line and paragraph separators. */
const LINE_BREAKS = /(?:\r\n|[\r\n\u2028\u2029])+/g;

/**
 * The title of a page as it is stored on a Pages item and in the page block of its parent: every run of line
 * breaks becomes one space and the result is trimmed. A title longer than `PAGE_TITLE_MAX_LENGTH` code points is a
 * `ValidationError` on `title`; an empty title is valid.
 */
export function normalizePageTitle(raw: string): string {
  const title = raw.replace(LINE_BREAKS, " ").trim();
  if (Array.from(title).length > PAGE_TITLE_MAX_LENGTH) {
    throw new ValidationError(`A page title is at most ${PAGE_TITLE_MAX_LENGTH} characters`, { field: "title" });
  }
  return title;
}
