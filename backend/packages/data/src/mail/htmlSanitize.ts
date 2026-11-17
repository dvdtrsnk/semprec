import sanitizeHtml from "sanitize-html";

/**
 * Untrusted HTML bodies are sanitized at serve time, not ingest, so the allowlist can improve
 * without a backfill. Remote images (tracking pixels) are stripped unless `allowRemoteImages`.
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
 * `style` allowlist: every pattern is a bounded keyword/unit that cannot carry `url(...)`.
 * Without it sanitize-html leaves `style` unfiltered, letting `background:url(...)` load a
 * tracking pixel.
 */
const CSS_COLOR_KEYWORDS =
  "black|silver|gray|grey|white|maroon|red|purple|fuchsia|green|lime|olive|yellow|navy|blue|teal|aqua|orange|pink|brown|gold|indigo|violet|coral|salmon|tan|beige|ivory|lavender|crimson|khaki|plum|orchid|turquoise|transparent|currentcolor|inherit|initial|unset";

const ALLOWED_STYLES = {
  "*": {
    // Fully anchored inside the parens: a `.*` would let `rgb(0,0,0) url(...)` match.
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
 * Protocol-relative sources (`//host`, any mix of `/` and `\`) name a remote host the scheme
 * allowlist never sees. Mirrors sanitize-html 2.17.7 / launder 1.7.1 normalization (drop
 * U+0000-U+0020 and `<!-- -->` comments), which is their current behavior, not a stable API.
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
    // data:/cid: images are never remote; http(s) ones are tracking-pixel candidates.
    allowedSchemesByTag: { img: options.allowRemoteImages ? ["http", "https", "data", "cid"] : ["data", "cid"] },
    disallowedTagsMode: "discard",
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
      // Runs before attribute filtering; drops protocol-relative image sources.
      img: (tagName, attribs) => {
        if (options.allowRemoteImages || typeof attribs.src !== "string" || !isProtocolRelativeSource(attribs.src))
          return { tagName, attribs };
        const { src: _remote, ...rest } = attribs;
        return { tagName, attribs: rest };
      },
    },
  });
}
