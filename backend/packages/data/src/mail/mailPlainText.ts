import sanitizeHtml from "sanitize-html";

/** The same plain-text approximation used for HTML-only mail search documents. */
export function htmlToPlainText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
}

export function buildMailPreview(text: string): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  let end = Math.min(collapsed.length, 200);
  // A cut between a high and low surrogate would leave an invalid UTF-16 string.
  if (
    end < collapsed.length &&
    /[\uD800-\uDBFF]/u.test(collapsed.charAt(end - 1)) &&
    /[\uDC00-\uDFFF]/u.test(collapsed.charAt(end))
  ) {
    end -= 1;
  }
  return collapsed.slice(0, end);
}
