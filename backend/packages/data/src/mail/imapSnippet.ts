// Decodes the leading bytes of a MIME body part, cut at an arbitrary octet by a partial IMAP fetch.

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
