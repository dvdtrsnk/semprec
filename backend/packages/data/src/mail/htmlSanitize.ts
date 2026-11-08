import sanitizeHtml from "sanitize-html";

/**
 * Serve-time sanitization (issue #26) of untrusted HTML message bodies — called by
 * the Emails projection on generic item reads (issue #1490).
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
  "a",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "p",
  "br",
  "hr",
  "div",
  "span",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "img",
  "font",
];

/**
 * Explicit property allowlist for the `style` attribute — every value pattern below is a
 * bounded keyword/unit, none can carry a `url(...)` reference. Without this, `allowedStyles`
 * being unset leaves `style` completely unfiltered (verified against sanitize-html's own
 * `filterCss`), which would let `style="background:url(http://tracker.example/pixel.gif)"`
 * on any allowed tag load a remote image exactly like the `img[src]` case below already
 * blocks — the same tracking-pixel vector through a second door.
 */
// A bounded set of standard CSS named colors, rather than `/^[a-z]+$/` (which structurally
// can't smuggle a `url(...)` reference either, since it has no room for parens, but does
// accept meaningless/non-standard keywords with no real value — tightened for precision, not
// because the looser pattern was actually exploitable).
const CSS_COLOR_KEYWORDS =
  "black|silver|gray|grey|white|maroon|red|purple|fuchsia|green|lime|olive|yellow|navy|blue|teal|aqua|orange|pink|brown|gold|indigo|violet|coral|salmon|tan|beige|ivory|lavender|crimson|khaki|plum|orchid|turquoise|transparent|currentcolor|inherit|initial|unset";

const ALLOWED_STYLES = {
  "*": {
    // The rgb()/rgba() pattern is fully anchored down to digits/percent/dot inside the
    // parens — an unbounded `.*` here would (and, in an earlier version of this file, did)
    // let a second `url(...)` function ride along inside a value that still matches
    // start-to-end (e.g. `rgb(0,0,0) url(...)`), since `.` also matches `)` and `(`.
    color: [
      /^#[0-9a-f]{3,6}$/i,
      /^rgba?\(\s*\d{1,3}%?(\s*,\s*\d{1,3}%?){2}(\s*,\s*(0|1|0?\.\d+))?\s*\)$/i,
      new RegExp(`^(${CSS_COLOR_KEYWORDS})$`, "i"),
    ],
    "text-align": [/^(left|right|center|justify)$/],
    "font-weight": [/^(normal|bold|bolder|lighter|[1-9]00)$/],
    "font-style": [/^(normal|italic|oblique)$/],
    "text-decoration": [/^(none|underline|overline|line-through)$/],
  },
};

/**
 * Whether an `img` source is protocol-relative (`//host/...`, or any mix of `/` and `\`): it names a
 * remote host without a scheme, so the scheme allowlist below never sees it, and sanitize-html
 * accepts it by default. The check mirrors how the installed sanitize-html 2.17.7 / launder 1.7.1
 * classify such a value: characters U+0000-U+0020 are removed and `<!-- ... -->` comments cut out
 * before two leading slashes are tested. That normalization is their current behavior, not a stable
 * API of those packages; the cases this code is known to cover are the ones its tests list.
 * Entities are already decoded by the HTML parser when this runs.
 */
function isProtocolRelativeSource(src: string): boolean {
  let value = Array.from(src)
    .filter((character) => (character.codePointAt(0) ?? 0) > 0x20)
    .join("");
  for (;;) {
    const start = value.indexOf("<!--");
    if (start === -1) break;
    const end = value.indexOf("-->", start + 4);
    if (end === -1) break;
    value = value.slice(0, start) + value.slice(end + 3);
  }
  return /^[/\\]{2}/.test(value);
}

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
    // "remote". An http(s) src is a tracking-pixel candidate, and so is a protocol-relative one,
    // which the `img` transform below drops because no scheme allowlist can see it.
    allowedSchemesByTag: { img: options.allowRemoteImages ? ["http", "https", "data", "cid"] : ["data", "cid"] },
    disallowedTagsMode: "discard",
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
      // Runs before attribute filtering. Links and every other source keep the policy above; only a
      // protocol-relative image source is dropped unless remote images are allowed.
      img: (tagName, attribs) => {
        if (options.allowRemoteImages || typeof attribs.src !== "string" || !isProtocolRelativeSource(attribs.src))
          return { tagName, attribs };
        const { src: _remote, ...rest } = attribs;
        return { tagName, attribs: rest };
      },
    },
  });
}
