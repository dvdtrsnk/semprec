import { ValidationError } from "../errors.js";

/** The longest page title, in Unicode code points. */
export const PAGE_TITLE_MAX_LENGTH = 500;

/** A run of line breaks, including the Unicode line and paragraph separators. */
const LINE_BREAKS = /(?:\r\n|[\r\n\u2028\u2029])+/g;

/**
 * The title of a page as it is stored on a Pages item and in the page block of its parent: every run of line
 * breaks becomes one space and the result is trimmed. A title longer than `PAGE_TITLE_MAX_LENGTH` code points is a
 * `ValidationError` on `title`, unless `truncate` is set, which cuts it to the limit instead (the mirror job copies
 * text an editor typed and must not fail on it); an empty title is valid.
 */
export function normalizePageTitle(raw: string, options: { truncate?: boolean } = {}): string {
  const title = raw.replace(LINE_BREAKS, " ").trim();
  const codePoints = Array.from(title);
  if (codePoints.length <= PAGE_TITLE_MAX_LENGTH) return title;
  if (options.truncate === true) return codePoints.slice(0, PAGE_TITLE_MAX_LENGTH).join("").trimEnd();
  throw new ValidationError(`A page title is at most ${PAGE_TITLE_MAX_LENGTH} characters`, { field: "title" });
}
