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
 * Explicit property allowlist for the `style` attribute — every value pattern below is a
 * bounded keyword/unit, none can carry a `url(...)` reference. Without this, `allowedStyles`
 * being unset leaves `style` completely unfiltered (verified against sanitize-html's own
 * `filterCss`), which would let `style="background:url(http://tracker.example/pixel.gif)"`
 * on any allowed tag load a remote image exactly like the `img[src]` case below already
 * blocks — the same tracking-pixel vector through a second door.
 */
const ALLOWED_STYLES = {
  "*": {
    // The rgb()/rgba() pattern is fully anchored down to digits/percent/dot inside the
    // parens — an unbounded `.*` here would (and, in an earlier version of this file, did)
    // let a second `url(...)` function ride along inside a value that still matches
    // start-to-end (e.g. `rgb(0,0,0) url(...)`), since `.` also matches `)` and `(`.
    color: [/^#[0-9a-f]{3,6}$/i, /^rgba?\(\s*\d{1,3}%?(\s*,\s*\d{1,3}%?){2}(\s*,\s*(0|1|0?\.\d+))?\s*\)$/i, /^[a-z]+$/i],
    "text-align": [/^(left|right|center|justify)$/],
    "font-weight": [/^(normal|bold|bolder|lighter|[1-9]00)$/],
    "font-style": [/^(normal|italic|oblique)$/],
    "text-decoration": [/^(none|underline|overline|line-through)$/],
  },
};

export function sanitizeMailHtml(html: string, options: SanitizeMailHtmlOptions = {}): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "title", "target"],
      img: ["src", "alt", "width", "height"],
      font: ["color", "size", "face"],
      "*": ["style"],
    },
    allowedStyles: ALLOWED_STYLES,
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
