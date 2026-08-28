import sanitizeHtml from "sanitize-html";

/**
 * Serve-time sanitization (issue #26) of untrusted HTML message bodies — called by
 * whatever reads a message body for display (issue #27's reading view; there is no such
 * caller yet in this issue's scope, but the function itself is exercised directly below).
 * Deliberately *not* run once at ingest and stored sanitized: running at serve time lets the
 * allowlist improve later without a backfill over every already-stored message.
 *
 * Remote images are stripped by default (the same default as Gmail/Mail.app — a bare `src`
 * on a foreign host is a common tracking-pixel vector, confirming "message was opened" to
 * the sender) unless `allowRemoteImages` is set, mirroring a per-message "Load images" action.
 */
export interface SanitizeMailHtmlOptions {
  allowRemoteImages?: boolean;
}

const ALLOWED_TAGS = [
  "a", "b", "strong", "i", "em", "u", "s", "strike", "p", "br", "hr", "div", "span",
  "ul", "ol", "li", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td", "img", "font",
];

export function sanitizeMailHtml(html: string, options: SanitizeMailHtmlOptions = {}): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "title", "target"],
      img: ["src", "alt", "width", "height"],
      font: ["color", "size", "face"],
      "*": ["style"],
    },
    // Inline data:/cid: images (a rendering asset attached to the message itself) are never
    // "remote" — only a bare http(s) src is a tracking-pixel candidate.
    allowedSchemesByTag: { img: options.allowRemoteImages ? ["http", "https", "data", "cid"] : ["data", "cid"] },
    disallowedTagsMode: "discard",
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
    },
  });
}
