// Decodes the leading bytes of a MIME body part, cut at an arbitrary octet by a partial IMAP fetch.
import type { MessageStructureObject } from "imapflow";
import type { ImapSnippetPart } from "./imapReconcile.js";
import { htmlToPlainText } from "./mailPlainText.js";

/** How many octets of a message's text part an index message's snippet is read from. */
export const IMAP_SNIPPET_BYTES = 2048;

function decodeQuotedPrintablePrefix(raw: string): Buffer {
  // A cut can split an `=XX` escape or a soft line break; the incomplete tail is dropped.
  const complete = raw.replace(/=(?:[0-9A-Fa-f]?|\r)$/, "");
  const bytes: number[] = [];
  for (let i = 0; i < complete.length; i++) {
    const char = complete[i]!;
    if (char === "=") {
      const next = complete.slice(i + 1, i + 3);
      if (next === "\r\n") {
        i += 2;
        continue;
      }
      if (complete[i + 1] === "\n") {
        i += 1;
        continue;
      }
      if (/^[0-9A-Fa-f]{2}$/.test(next)) {
        bytes.push(Number.parseInt(next, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(char.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

function decodeBase64Prefix(raw: string): Buffer {
  const compact = raw.replace(/[^A-Za-z0-9+/=]/g, "");
  return Buffer.from(compact.slice(0, compact.length - (compact.length % 4)), "base64");
}

function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  let decoder: InstanceType<typeof TextDecoder>;
  try {
    decoder = new TextDecoder(charset ?? "utf-8");
  } catch (err) {
    // An unknown label: the part is read as UTF-8, which keeps every ASCII character of it.
    if (!(err instanceof RangeError)) throw err;
    decoder = new TextDecoder("utf-8");
  }
  // A cut inside a multi-byte character decodes to a trailing replacement character.
  return decoder.decode(bytes).replace(/�+$/, "");
}

/**
 * The text of a body part's first octets, as `encoding` (Content-Transfer-Encoding) and `charset` describe the whole
 * part. A character, escape or base64 group the cut split is dropped.
 */
export function decodeBodyPartPrefix(raw: Buffer, encoding: string | undefined, charset: string | undefined): string {
  const latin1 = raw.toString("latin1");
  const transfer = encoding?.toLowerCase();
  const bytes =
    transfer === "base64"
      ? decodeBase64Prefix(latin1)
      : transfer === "quoted-printable"
        ? decodeQuotedPrintablePrefix(latin1)
        : raw;
  return decodeCharset(bytes, charset);
}

/** The snippet of a message from the leading octets of its snippet part, as an index message's preview reads it. */
export function imapSnippetText(raw: Buffer, part: ImapSnippetPart): string {
  const text = decodeBodyPartPrefix(raw.subarray(0, IMAP_SNIPPET_BYTES), part.encoding, part.charset);
  return part.html ? htmlToPlainText(text) : text;
}

/**
 * The leading octets of the leaf part `section` (a part number such as `1.2`) found in the leading octets of a
 * multipart message's TEXT section, `text`: each multipart level on the way is split at the boundary its BODYSTRUCTURE
 * names, and the part's own header block is skipped. `undefined` when the cut ends before the part's content starts, or
 * the way passes anything but a multipart node (an attached message).
 */
export function bodyPartPrefixInText(text: Buffer, root: MessageStructureObject, section: string): Buffer | undefined {
  let body = text.toString("latin1");
  let node = root;
  for (const index of section.split(".").map(Number)) {
    const boundary = node.parameters?.boundary;
    const child = node.childNodes?.[index - 1];
    if (!node.type.startsWith("multipart/") || !boundary || !child) return undefined;
    const part = nthMimePart(body, boundary, index);
    if (part === undefined) return undefined;
    // The part's content follows the blank line that ends its header block; a part without header fields starts with it.
    const headerEnd = part.indexOf("\r\n\r\n");
    const contentStart = part.startsWith("\r\n") ? 2 : headerEnd === -1 ? -1 : headerEnd + 4;
    if (contentStart === -1) return undefined;
    body = part.slice(contentStart);
    node = child;
  }
  return Buffer.from(body, "latin1");
}

/** The `n`th (1-based) part of a multipart body between its `boundary` delimiters, cut where `body` is cut. */
function nthMimePart(body: string, boundary: string, n: number): string | undefined {
  const delimiter = `--${boundary}`;
  // The first delimiter may open the body; every other one follows a line break.
  let at = body.startsWith(delimiter) ? 0 : body.indexOf(`\r\n${delimiter}`);
  for (let found = 1; at !== -1; found++) {
    const afterDelimiter = at + (body.startsWith(delimiter, at) ? 0 : 2) + delimiter.length;
    if (body.startsWith("--", afterDelimiter)) return undefined;
    const lineEnd = body.indexOf("\r\n", afterDelimiter);
    if (lineEnd === -1) return undefined;
    const start = lineEnd + 2;
    const next = body.indexOf(`\r\n${delimiter}`, start);
    if (found === n) return next === -1 ? body.slice(start) : body.slice(start, next);
    at = next;
  }
  return undefined;
}
