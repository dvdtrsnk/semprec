import { ValidationError } from "../errors.js";

/** In Unicode code points. */
export const PAGE_TITLE_MAX_LENGTH = 500;

const LINE_BREAKS = /(?:\r\n|[\r\n\u2028\u2029])+/g;

/**
 * Line-break runs become one space, then trimmed. Too long is a `ValidationError` unless `truncate` is set (the
 * mirror job copies typed text and must not fail on it).
 */
export function normalizePageTitle(raw: string, options: { truncate?: boolean } = {}): string {
  const title = raw.replace(LINE_BREAKS, " ").trim();
  const codePoints = Array.from(title);
  if (codePoints.length <= PAGE_TITLE_MAX_LENGTH) return title;
  if (options.truncate === true) return codePoints.slice(0, PAGE_TITLE_MAX_LENGTH).join("").trimEnd();
  throw new ValidationError(`A page title is at most ${PAGE_TITLE_MAX_LENGTH} characters`, { field: "title" });
}
