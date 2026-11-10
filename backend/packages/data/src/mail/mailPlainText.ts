import sanitizeHtml from "sanitize-html";

/** Maximum length of a stored mail preview, in UTF-16 code units. */
export const MAIL_PREVIEW_MAX_LENGTH = 200;

/** Plain-text approximation of an HTML body: every tag and attribute is stripped. */
export function htmlToPlainText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Collapses whitespace and truncates to at most 200 UTF-16 code units without splitting a surrogate pair. */
export function buildMailPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAIL_PREVIEW_MAX_LENGTH) return collapsed;
  let end = MAIL_PREVIEW_MAX_LENGTH;
  if (isHighSurrogate(collapsed.charCodeAt(end - 1))) end -= 1;
  return collapsed.slice(0, end);
}

/** The preview of a message: its text part, else its converted HTML part. */
export function buildMailPreviewFromBody(
  bodyText: string | null | undefined,
  bodyHtml: string | null | undefined,
): string {
  return buildMailPreview(bodyText ?? (bodyHtml ? htmlToPlainText(bodyHtml) : ""));
}
