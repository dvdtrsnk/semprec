import { BLOCK_TYPE_RULES, MAX_INDENT, MIN_INDENT, isBlockType, type BlockType } from "./blockTypes.js";
import { BlockInputError, validateBlockInput, type BlockIssue, type TextRun } from "./pageBlocks.js";

/*
 * Canonical Markdown for page blocks: a deliberate line-oriented subset, not CommonMark.
 * One non-empty line is one block. The parser and serializer are pure and import nothing
 * but this module's own files, so the WebView editor runs the same code.
 *
 * Raw outer line whitespace is normalized; canonical content whitespace is escaped.
 * A number block is always written as `1.`.
 */

const PAGE_LINK_PREFIX = "semprec://page/";
const ITEM_LINK_PREFIX = "semprec://items/";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMENT_PATTERN = /^<!-- semprec:block (.*) -->$/;
const LIST_TYPES: ReadonlySet<string> = new Set(["bullet", "number", "todo"]);
const WORD_CHAR = /[\p{L}\p{N}]/u;
const PUNCTUATION = /[!-/:-@[-`{-~]/;

/** A block as the serializer accepts it: a `PageBlock`, or one whose type key the registry does not know. */
export interface SerializableBlock {
  /** `null` marks the synthetic empty block of an empty document, which is not written. */
  id: string | null;
  type: string;
  indent: number;
  done?: boolean;
  text?: readonly TextRun[];
  pageId?: string | null;
}

export interface SerializeOptions {
  /** Title written inside a page block link; an empty title is written when absent. */
  resolvePageTitle?: (pageId: string) => string;
  /** Write the `semprec:block` id comment before every block. */
  withIds?: boolean;
}

export interface ParseOptions {
  /** Default true. When false, a page link line fails parsing with a `BlockInputError`. */
  allowPage?: boolean;
  /** Ids for blocks without an id comment; defaults to `b1`, `b2`, ... Ids already used are skipped. */
  createId?: () => string;
}

/** A parsed block. `type` is a registry key, or the key preserved from a comment for an unknown type. */
export interface ParsedBlock {
  id: string;
  type: string;
  indent: number;
  done?: boolean;
  /** Always runs: the parser never produces the plain-string form of `BlockInput.text`. */
  text?: TextRun[];
  pageId?: string;
}

function clampIndent(value: number): number {
  return Math.min(MAX_INDENT, Math.max(MIN_INDENT, Math.floor(value)));
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

interface Marks {
  bold: boolean;
  italic: boolean;
  code: boolean;
  href: string | null;
}

interface Piece {
  kind: "text" | "br";
  text: string;
  marks: Marks;
}

interface Span {
  kind: "link" | "bold" | "italic";
  start: number;
  end: number;
  href: string;
  html: boolean;
}

const KIND_RANK = { link: 0, bold: 1, italic: 2 } as const;

function toPieces(runs: readonly TextRun[]): Piece[] {
  const pieces: Piece[] = [];
  for (const run of runs) {
    const marks: Marks = {
      bold: run.attributes?.bold === true,
      italic: run.attributes?.italic === true,
      code: run.attributes?.code === true,
      href: run.attributes?.link?.href ? run.attributes.link.href : null,
    };
    const segments = run.insert.split("\n");
    segments.forEach((segment, index) => {
      if (segment !== "") {
        pieces.push({ kind: "text", text: segment, marks });
      }
      if (index < segments.length - 1) {
        pieces.push({ kind: "br", text: "", marks });
      }
    });
  }
  return pieces;
}

function buildSpans(pieces: readonly Piece[]): Span[] {
  const spans: Span[] = [];
  const collect = (kind: Span["kind"], applies: (marks: Marks) => boolean): void => {
    let current: Span | null = null;
    pieces.forEach((piece, index) => {
      if (!applies(piece.marks)) {
        current = null;
        return;
      }
      // Bold and italic spans are split at link boundaries so that a link is always outermost.
      const href = piece.marks.href ?? "";
      if (current !== null && current.href === href) {
        current.end = index + 1;
      } else {
        current = { kind, start: index, end: index + 1, href, html: false };
        spans.push(current);
      }
    });
  };
  collect("link", (marks) => marks.href !== null);
  collect("bold", (marks) => marks.bold);
  collect("italic", (marks) => marks.italic);
  return spans;
}

function markHtmlSpans(spans: Span[], pieces: readonly Piece[]): void {
  const formatting = spans.filter((span) => span.kind !== "link");
  for (const span of formatting) {
    const text = pieces
      .slice(span.start, span.end)
      .map((piece) => piece.text)
      .join("");
    if (text === "" || /^\s/.test(text) || /\s$/.test(text)) {
      span.html = true;
    }
  }
  for (const a of formatting) {
    for (const b of formatting) {
      if (a.start < b.start && b.start < a.end && a.end < b.end) {
        a.html = true;
        b.html = true;
      }
    }
  }
}

function escapePlain(text: string, offset: number, whole: string): string {
  let out = "";
  const leading = /^[^\S\n]*/u.exec(whole)?.[0].length ?? 0;
  const trailing = whole.length - (/[^\S\n]*$/u.exec(whole)?.[0].length ?? 0);
  for (let i = 0; i < text.length;) {
    const point = text.codePointAt(i);
    if (point === undefined) break;
    const char = String.fromCodePoint(point);
    const position = offset + i;
    if (char !== "\n" && /\s/u.test(char) && (position < leading || position >= trailing)) {
      out += `&#x${point.toString(16)};`;
    } else if (char === "&" && whitespaceReference(whole.slice(position)) !== null) {
      out += "\\&";
    } else if (char === "\\" || char === "*" || char === "`" || char === "[" || char === "]" || char === "<") {
      out += `\\${char}`;
    } else if (char === "_") {
      const before = whole[offset + i - 1];
      const after = whole[offset + i + 1];
      const inWord = before !== undefined && after !== undefined && WORD_CHAR.test(before) && WORD_CHAR.test(after);
      out += inWord ? char : "\\_";
    } else {
      out += char;
    }
    i += char.length;
  }
  return out;
}

/** Only the canonical numeric spelling of non-LF ECMAScript whitespace is recognized. */
function whitespaceReference(source: string): { text: string; length: number } | null {
  const match = /^&#x([1-9a-f][0-9a-f]*);/.exec(source);
  if (!match || match[1] === undefined) return null;
  const point = Number.parseInt(match[1], 16);
  if (point > 0x10ffff) return null;
  const text = String.fromCodePoint(point);
  return text !== "\n" && /^\s$/u.test(text) ? { text, length: match[0].length } : null;
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest === 0 ? 1 : longest + 1);
  const pad =
    text.startsWith("`") || text.endsWith("`") || (text.trim() !== "" && (text.startsWith(" ") || text.endsWith(" ")))
      ? " "
      : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function encodePageId(pageId: string): string {
  let encoded = "";
  for (let index = 0; index < pageId.length; index += 1) {
    const unit = pageId.charAt(index);
    encoded += /^[A-Za-z0-9._~-]$/.test(unit)
      ? unit
      : `\\u${pageId.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return encoded;
}

function decodeUtf16Escapes(encoded: string): string {
  return encoded.replace(/\\u([0-9A-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function linkDestination(href: string): string {
  if (href.startsWith(PAGE_LINK_PREFIX) || /[\s()<>\\]/.test(href)) {
    const escaped = href.replace(/&#xa;|[\n\\<>]/g, (part) => {
      if (part === "\n") return "&#xa;";
      if (part === "&#xa;") return "\\&#xa;";
      return `\\${part}`;
    });
    return `<${escaped}>`;
  }
  return href;
}

function italicOpenToken(span: Span, before: string | undefined, after: string | undefined): string {
  if (span.html) return "<em>";
  const inWord = (before !== undefined && WORD_CHAR.test(before)) || (after !== undefined && WORD_CHAR.test(after));
  return inWord ? "*" : "_";
}

export function serializeInline(runs: readonly TextRun[]): string {
  const pieces = toPieces(runs);
  const spans = buildSpans(pieces);
  markHtmlSpans(spans, pieces);
  const offsets: number[] = [];
  let whole = "";
  for (const piece of pieces) {
    offsets.push(whole.length);
    whole += piece.kind === "br" ? "\n" : piece.text;
  }
  offsets.push(whole.length);

  // The italic delimiter depends on its outer neighbours, so it is decided once per span.
  const italicToken = new Map<Span, string>();
  for (const span of spans) {
    if (span.kind === "italic") {
      const start = offsets[span.start] as number;
      const end = offsets[span.end] as number;
      italicToken.set(span, italicOpenToken(span, whole[start - 1], whole[end]));
    }
  }
  const tokenFor = (span: Span): string => {
    if (span.kind === "bold") return span.html ? "<strong>" : "**";
    return italicToken.get(span) as string;
  };
  const closeFor = (span: Span): string => {
    const open = tokenFor(span);
    return open.startsWith("<") ? `</${open.slice(1)}` : open;
  };

  let out = "";
  for (let index = 0; index <= pieces.length; index += 1) {
    const closing = spans
      .filter((span) => span.end === index)
      .sort((a, b) => b.start - a.start || KIND_RANK[b.kind] - KIND_RANK[a.kind]);
    for (const span of closing) {
      out += span.kind === "link" ? `](${linkDestination(span.href)})` : closeFor(span);
    }
    const opening = spans
      .filter((span) => span.start === index)
      .sort((a, b) => b.end - a.end || KIND_RANK[a.kind] - KIND_RANK[b.kind]);
    for (const span of opening) {
      out += span.kind === "link" ? "[" : tokenFor(span);
    }
    const piece = pieces[index];
    if (piece === undefined) continue;
    if (piece.kind === "br") {
      out += piece.marks.code ? "<code><br></code>" : "<br>";
    } else if (piece.marks.code) {
      out += codeSpan(piece.text);
    } else {
      out += escapePlain(piece.text, offsets[index] as number, whole);
    }
  }
  return out;
}

/** Escapes a line start that the parser would read as a block marker, for blocks written without one. */
function escapeLineStart(content: string): string {
  if (content.startsWith("#") || content.startsWith(">")) {
    return `\\${content}`;
  }
  if (/^[-+](?: |$)/.test(content)) {
    return `\\${content}`;
  }
  const number = /^(\d+)\.(?: |$)/.exec(content);
  if (number) {
    return `${number[1]}\\.${content.slice((number[1] as string).length + 1)}`;
  }
  return content;
}

function withMarker(marker: string, content: string): string {
  return content === "" ? marker : `${marker} ${content}`;
}

function encodeCommentField(value: string): string {
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charAt(index);
    encoded += /^[A-Za-z0-9._:~-]$/.test(unit)
      ? unit
      : `\\u${value.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return encoded;
}

/** Canonical Markdown for `blocks`. Never mutates its input. */
export function serializeBlocks(blocks: readonly SerializableBlock[], options: SerializeOptions = {}): string {
  const lines: string[] = [];
  let previousWasList = false;
  for (const block of blocks) {
    if (block.id === null) {
      continue;
    }
    const known = isBlockType(block.type);
    let type: BlockType | "unknown" = known ? (block.type as BlockType) : "unknown";
    if (type === "page" && !block.pageId) {
      type = "text";
    }
    const indent = Number.isInteger(block.indent) ? clampIndent(block.indent) : 0;
    const isList = LIST_TYPES.has(type);
    const indentPrefix = isList ? "  ".repeat(indent) : "";
    const runs = type === "page" ? [] : (block.text ?? []);
    const content = type === "page" ? "" : serializeInline(runs);

    let line: string;
    switch (type) {
      case "page": {
        const title = options.resolvePageTitle?.(block.pageId as string) ?? "";
        const caption = serializeInline([{ insert: title }]);
        line = `[${caption}](${PAGE_LINK_PREFIX}${encodePageId(block.pageId as string)})`;
        break;
      }
      case "h1":
        line = withMarker("#", content);
        break;
      case "h2":
        line = withMarker("##", content);
        break;
      case "h3":
        line = withMarker("###", content);
        break;
      case "bullet":
        line = indentPrefix + withMarker("-", content);
        break;
      case "number":
        line = indentPrefix + withMarker("1.", content);
        break;
      case "todo":
        line = indentPrefix + withMarker(block.done === true ? "- [x]" : "- [ ]", content);
        break;
      case "quote":
        line = withMarker(">", content);
        break;
      default:
        line = escapeLineStart(content);
    }

    const needsComment =
      options.withIds === true || type === "unknown" || (!isList && indent !== 0) || (line === "" && type !== "page");
    const entry: string[] = [];
    if (needsComment) {
      const typeKey = type === "unknown" ? (block.type === "" ? '""' : encodeCommentField(block.type)) : type;
      entry.push(`<!-- semprec:block id=${encodeCommentField(block.id)} type=${typeKey} indent=${indent} -->`);
    }
    if (line !== "") {
      entry.push(line);
    }
    if (lines.length > 0 && !(isList && previousWasList)) {
      lines.push("");
    }
    lines.push(...entry);
    previousWasList = isList;
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Inline parser
// ---------------------------------------------------------------------------

interface InlineState {
  bold: boolean;
  italic: boolean;
  href: string | null;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

/** Length of the backtick fence starting at `index`. */
function fenceLength(source: string, index: number): number {
  let length = 0;
  while (source[index + length] === "`") length += 1;
  return length;
}

/** The end index (exclusive) of the code span opening at `index`, or -1 when the fence never closes. */
function codeSpanEnd(source: string, index: number): number {
  const length = fenceLength(source, index);
  let cursor = index + length;
  while (cursor < source.length) {
    if (source[cursor] === "`") {
      const close = fenceLength(source, cursor);
      if (close === length) return cursor + close;
      cursor += close;
    } else {
      cursor += 1;
    }
  }
  return -1;
}

/** Finds the next unescaped `token` at or after `from`, skipping code spans; `accept` filters candidates. */
function findDelimiter(
  source: string,
  from: number,
  token: string,
  accept: (index: number) => boolean = () => true,
): number {
  let cursor = from;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
    } else if (char === "`") {
      const end = codeSpanEnd(source, cursor);
      cursor = end === -1 ? cursor + fenceLength(source, cursor) : end;
    } else if (source.startsWith(token, cursor) && accept(cursor)) {
      return cursor;
    } else {
      cursor += 1;
    }
  }
  return -1;
}

function findLinkTextEnd(source: string, openIndex: number): number {
  let depth = 0;
  let cursor = openIndex;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "`") {
      const end = codeSpanEnd(source, cursor);
      cursor = end === -1 ? cursor + fenceLength(source, cursor) : end;
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
    cursor += 1;
  }
  return -1;
}

/** Parses `(destination)` at `index`; returns the destination and the index after `)`. */
function parseDestination(source: string, index: number): { href: string; next: number } | null {
  if (source[index] !== "(") return null;
  let cursor = index + 1;
  let href = "";
  if (source[cursor] === "<") {
    cursor += 1;
    while (cursor < source.length && source[cursor] !== ">") {
      if (source[cursor] === "\\" && cursor + 1 < source.length) {
        href += source[cursor + 1];
        cursor += 2;
      } else if (source.startsWith("&#xa;", cursor)) {
        href += "\n";
        cursor += "&#xa;".length;
      } else {
        href += source[cursor];
        cursor += 1;
      }
    }
    if (source[cursor] !== ">") return null;
    cursor += 1;
  } else {
    while (cursor < source.length && !/[\s)]/.test(source[cursor] as string)) {
      href += source[cursor];
      cursor += 1;
    }
  }
  if (source[cursor] !== ")" || href === "") return null;
  return { href, next: cursor + 1 };
}

function withScheme(href: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href.replace(/^\/\//, "")}`;
}

function runAttributes(state: InlineState, code: boolean): TextRun["attributes"] {
  const attributes: NonNullable<TextRun["attributes"]> = {};
  if (state.bold) attributes.bold = true;
  if (state.italic) attributes.italic = true;
  if (code) attributes.code = true;
  if (state.href !== null) attributes.link = { href: state.href };
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

function sameAttributes(a: TextRun["attributes"], b: TextRun["attributes"]): boolean {
  return a?.bold === b?.bold && a?.italic === b?.italic && a?.code === b?.code && a?.link?.href === b?.link?.href;
}

function parseInlineInto(source: string, initial: InlineState, runs: TextRun[]): void {
  const state: InlineState = { ...initial };
  let buffer = "";
  const flush = (): void => {
    if (buffer === "") return;
    runs.push(withAttributes(buffer, runAttributes(state, false)));
    buffer = "";
  };
  let i = 0;
  while (i < source.length) {
    const char = source[i] as string;
    if (char === "\\" && i + 1 < source.length && PUNCTUATION.test(source[i + 1] as string)) {
      buffer += source[i + 1];
      i += 2;
      continue;
    }
    const reference = char === "&" ? whitespaceReference(source.slice(i)) : null;
    if (reference !== null) {
      buffer += reference.text;
      i += reference.length;
      continue;
    }
    if (char === "`") {
      const end = codeSpanEnd(source, i);
      if (end === -1) {
        const length = fenceLength(source, i);
        buffer += source.slice(i, i + length);
        i += length;
        continue;
      }
      const length = fenceLength(source, i);
      let content = source.slice(i + length, end - length);
      if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") {
        content = content.slice(1, -1);
      }
      flush();
      runs.push(withAttributes(content, runAttributes(state, true)));
      i = end;
      continue;
    }
    if (char === "<") {
      if (source.startsWith("<code><br></code>", i)) {
        flush();
        runs.push(withAttributes("\n", runAttributes(state, true)));
        i += "<code><br></code>".length;
        continue;
      }
      const tag = /^<(\/?)(strong|b|em|i)>/i.exec(source.slice(i));
      if (tag) {
        flush();
        const open = tag[1] === "";
        if ((tag[2] as string).toLowerCase() === "strong" || (tag[2] as string).toLowerCase() === "b") {
          state.bold = open;
        } else {
          state.italic = open;
        }
        i += tag[0].length;
        continue;
      }
      const br = /^<br\s*\/?>/i.exec(source.slice(i));
      if (br) {
        buffer += "\n";
        i += br[0].length;
        continue;
      }
    }
    if (char === "[" && state.href === null) {
      const end = findLinkTextEnd(source, i);
      const destination = end === -1 ? null : parseDestination(source, end + 1);
      if (destination) {
        flush();
        parseInlineInto(source.slice(i + 1, end), { ...state, href: withScheme(destination.href) }, runs);
        i = destination.next;
        continue;
      }
    }
    if (char === "*" && source[i + 1] === "*") {
      const closes = state.bold;
      const opens =
        !closes &&
        !isSpace(source[i + 2]) &&
        findDelimiter(source, i + 2, "**", (index) => !isSpace(source[index - 1])) !== -1;
      if (closes || opens) {
        flush();
        state.bold = opens;
        i += 2;
        continue;
      }
    }
    if (char === "*" && source[i + 1] !== "*") {
      const single = (index: number): boolean => source[index + 1] !== "*" && source[index - 1] !== "*";
      const opens = !state.italic && !isSpace(source[i + 1]) && findDelimiter(source, i + 1, "*", single) !== -1;
      if (state.italic || opens) {
        flush();
        state.italic = opens;
        i += 1;
        continue;
      }
    }
    if (char === "_") {
      const opens =
        !state.italic &&
        !isWordChar(source[i - 1]) &&
        !isSpace(source[i + 1]) &&
        findDelimiter(source, i + 1, "_", (index) => !isWordChar(source[index + 1])) !== -1;
      const closes = state.italic && !isWordChar(source[i + 1]);
      if (opens || closes) {
        flush();
        state.italic = opens;
        i += 1;
        continue;
      }
    }
    buffer += char;
    i += 1;
  }
  flush();
}

function withAttributes(insert: string, attributes: TextRun["attributes"]): TextRun {
  return attributes ? { insert, attributes } : { insert };
}

function parseInline(source: string): TextRun[] {
  const raw: TextRun[] = [];
  parseInlineInto(source, { bold: false, italic: false, href: null }, raw);
  const merged: TextRun[] = [];
  for (const run of raw) {
    const last = merged[merged.length - 1];
    if (last && sameAttributes(last.attributes, run.attributes)) {
      last.insert += run.insert;
    } else if (run.insert !== "") {
      merged.push({ ...run });
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Block parser
// ---------------------------------------------------------------------------

interface CommentAttributes {
  id?: string;
  type?: string;
  indent?: number;
}

function parseComment(body: string): CommentAttributes {
  const attributes: CommentAttributes = {};
  for (const match of body.matchAll(/(\w+)=(\S+)/g)) {
    const [, key, value] = match;
    if (key === undefined || value === undefined) continue;
    if (key === "id") attributes.id = decodeUtf16Escapes(value);
    if (key === "type" && (value === '""' || /^(?:[A-Za-z0-9._:~-]|\\u[0-9A-F]{4})+$/.test(value))) {
      attributes.type = value === '""' ? "" : decodeUtf16Escapes(value);
    }
    if (key === "indent" && /^\d+$/.test(value)) attributes.indent = clampIndent(Number(value));
  }
  return attributes;
}

interface ParsedLine {
  type: string;
  /** Indent read from the line itself; only list blocks carry one. */
  lineIndent: number | null;
  done?: boolean;
  text?: TextRun[];
  pageId?: string;
}

function parseLine(raw: string): ParsedLine {
  const spaces = /^ */.exec(raw)?.[0].length ?? 0;
  const line = raw.trim();
  const page = /^\[(?:\\.|[^\]\\])*\]\(semprec:\/\/page\/([^)\s]+)\)$/.exec(line);
  if (page && page[1] !== undefined) {
    return { type: "page", lineIndent: null, pageId: decodeUtf16Escapes(page[1]) };
  }
  const heading = /^(#{1,3})(?: +([\s\S]*))?$/.exec(line);
  if (heading) {
    return { type: `h${(heading[1] as string).length}`, lineIndent: null, text: parseInline(heading[2] ?? "") };
  }
  const listIndent = clampIndent(spaces / 2);
  const todo = /^[-*] \[([ xX])\](?: +([\s\S]*))?$/.exec(line);
  if (todo) {
    return { type: "todo", lineIndent: listIndent, done: todo[1] !== " ", text: parseInline(todo[2] ?? "") };
  }
  const bullet = /^[-*](?: +([\s\S]*))?$/.exec(line);
  if (bullet) {
    return { type: "bullet", lineIndent: listIndent, text: parseInline(bullet[1] ?? "") };
  }
  const number = /^\d+\.(?: +([\s\S]*))?$/.exec(line);
  if (number) {
    return { type: "number", lineIndent: listIndent, text: parseInline(number[1] ?? "") };
  }
  const quote = /^> ?([\s\S]*)$/.exec(line);
  if (quote) {
    return { type: "quote", lineIndent: null, text: parseInline((quote[1] as string).trim()) };
  }
  return { type: "text", lineIndent: null, text: parseInline(line) };
}

interface DraftBlock {
  id?: string;
  type: string;
  indent: number;
  done?: boolean;
  text?: TextRun[];
  pageId?: string;
}

/**
 * Block inputs for `markdown`. Block types come from the line markers; only a type key the
 * registry does not know is read from a `semprec:block` comment, on a plain line. Throws
 * `BlockInputError` when a known block fails registry validation or a page link appears
 * while `allowPage` is false.
 */
export function parseMarkdown(markdown: string, options: ParseOptions = {}): ParsedBlock[] {
  const allowPage = options.allowPage ?? true;
  const drafts: DraftBlock[] = [];
  const lineNumbers: number[] = [];
  let pending: { attributes: CommentAttributes; lineNumber: number } | null = null;

  const flushPending = (): void => {
    if (pending === null) return;
    const { attributes, lineNumber } = pending;
    const preserved = attributes.type !== undefined && !isBlockType(attributes.type);
    drafts.push({
      id: attributes.id,
      type: preserved
        ? (attributes.type as string)
        : isBlockType(attributes.type) && attributes.type !== "page"
          ? attributes.type
          : "text",
      indent: attributes.indent ?? 0,
      text: [],
      ...(attributes.type === "todo" ? { done: false } : {}),
    });
    lineNumbers.push(lineNumber);
    pending = null;
  };

  markdown.split("\n").forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (trimmed === "") {
      flushPending();
      return;
    }
    const comment = COMMENT_PATTERN.exec(trimmed);
    if (comment) {
      flushPending();
      pending = { attributes: parseComment(comment[1] as string), lineNumber };
      return;
    }
    const parsed = parseLine(line);
    const attributes: CommentAttributes = (pending as { attributes: CommentAttributes } | null)?.attributes ?? {};
    pending = null;
    if (parsed.type === "page" && !allowPage) {
      throw new BlockInputError([
        { path: `line ${lineNumber}`, code: "page_not_allowed", message: "page links are not allowed here" },
      ]);
    }
    const preservedType =
      parsed.type === "text" && attributes.type !== undefined && !isBlockType(attributes.type) ? attributes.type : null;
    drafts.push({
      id: attributes.id,
      type: preservedType ?? parsed.type,
      indent: parsed.lineIndent ?? attributes.indent ?? 0,
      ...(parsed.done === undefined ? {} : { done: parsed.done }),
      ...(parsed.text === undefined ? {} : { text: parsed.text }),
      ...(parsed.pageId === undefined ? {} : { pageId: parsed.pageId }),
    });
    lineNumbers.push(lineNumber);
  });
  flushPending();

  const used = new Set<string>();
  for (const draft of drafts) {
    if (draft.id !== undefined) {
      if (used.has(draft.id)) {
        draft.id = undefined;
      } else {
        used.add(draft.id);
      }
    }
  }
  let counter = 0;
  const createId =
    options.createId ??
    ((): string => {
      counter += 1;
      return `b${counter}`;
    });
  const nextId = (): string => {
    let id = createId();
    while (used.has(id)) id = createId();
    used.add(id);
    return id;
  };

  return drafts.map((draft, index) => {
    const id = draft.id ?? nextId();
    const block: ParsedBlock = { id, type: draft.type, indent: draft.indent };
    if (isBlockType(draft.type)) {
      const rule = BLOCK_TYPE_RULES[draft.type];
      // A page link carries no title text here; the title is resolved separately from the block's own text.
      if (!rule.hasPageId) block.text = draft.text ?? [];
      if (rule.hasDone) block.done = draft.done === true;
      if (rule.hasPageId) block.pageId = draft.pageId;
      const issues: BlockIssue[] = validateBlockInput(block).map((issue) => ({
        ...issue,
        path: `line ${lineNumbers[index]}: ${issue.path}`,
      }));
      if (issues.length > 0) throw new BlockInputError(issues);
    } else {
      block.text = draft.text ?? [];
    }
    return block;
  });
}

// ---------------------------------------------------------------------------
// stripMarkdown
// ---------------------------------------------------------------------------

/**
 * Plain text of `markdown` for subtitles and full-text indexing: markers, emphasis and link
 * syntax removed, soft breaks and block boundaries as one space, cut to
 * `maxChars` characters (code points).
 */
export function stripMarkdown(markdown: string, maxChars: number): string {
  if (!(maxChars > 0)) {
    return "";
  }
  // Parse page links as ordinary links here so their visible labels survive; page-model parsing
  // deliberately discards those labels because the page title is resolved separately.
  const withVisiblePageLabels = markdown.replace(
    /^([ \t]*\[(?:\\.|[^\]\\])*\])\(semprec:\/\/page\/[^)\s]+\)([ \t]*\r?)$/gm,
    "$1(https://example.invalid)$2",
  );
  const text = parseMarkdown(withVisiblePageLabels)
    .map((block) => (block.text ?? []).map((run) => run.insert).join(""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(text);
  return characters.length <= maxChars ? text : characters.slice(0, Math.floor(maxChars)).join("").trimEnd();
}

// ---------------------------------------------------------------------------
// Item links
// ---------------------------------------------------------------------------

/** Item references found in parsed blocks. */
export interface ItemLinks {
  /** Distinct lower-cased ids of `semprec://items/<uuid>` links, in order of first appearance. */
  ids: string[];
  /** True when some `semprec://items/` link carries something that is not a UUID. */
  malformed: boolean;
}

/**
 * Collects the item references (`[Title](semprec://items/<uuid>)`) from the link attributes of
 * parsed blocks. Pure: it neither checks that an item exists nor writes a relation; a server
 * checks the ids against the caller's tenant before it persists the blocks.
 */
export function collectItemLinks(blocks: readonly Pick<ParsedBlock, "text">[]): ItemLinks {
  const ids: string[] = [];
  const seen = new Set<string>();
  let malformed = false;
  for (const block of blocks) {
    for (const run of block.text ?? []) {
      const href = run.attributes?.link?.href;
      if (typeof href !== "string" || !href.startsWith(ITEM_LINK_PREFIX)) continue;
      const id = href.slice(ITEM_LINK_PREFIX.length);
      if (!UUID_PATTERN.test(id)) {
        malformed = true;
        continue;
      }
      const normalized = id.toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        ids.push(normalized);
      }
    }
  }
  return { ids, malformed };
}
