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

/**
 * Properties that structurally never take a `url()` value, plus a value-level `url(`
 * ban as defense in depth — `background`/`background-image`/`list-style-image`/`cursor`/
 * `content` are deliberately excluded, since those are exactly how a remote-image tracking
 * pixel is smuggled in through CSS instead of `<img src>` (sanitize-html's `filterCss`
 * otherwise passes the whole `style` attribute through unmodified when no `allowedStyles`
 * is given, which would silently defeat the `allowRemoteImages` gate above).
 */
const NO_URL_VALUE = /^(?!.*url\(:?).*$/i;
const SAFE_STYLE_PROPERTIES = [
  "color", "background-color", "font-size", "font-weight", "font-style", "font-family",
  "text-align", "text-decoration", "line-height", "letter-spacing", "white-space",
  "border", "border-color", "border-style", "border-width", "border-radius",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "width", "height", "max-width", "vertical-align",
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
    allowedStyles: {
      "*": Object.fromEntries(SAFE_STYLE_PROPERTIES.map((property) => [property, [NO_URL_VALUE]])),
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
