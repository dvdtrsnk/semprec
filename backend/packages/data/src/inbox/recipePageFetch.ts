import { createLogger } from "@semprec/shared";
import { htmlToPlainText } from "../mail/mailPlainText.js";
import type { OutboundHttp } from "../net/outboundAddressPolicy.js";

// Reading a page a person pasted into the Inbox (issue gh-1974): the request, with a timeout, a size cap and a
// content-type allow-list, and the readable text of what came back. Everything here is about bytes and text; the
// outbound address policy is the `fetch` the caller passes (`createOutboundHttp().fetch`, see
// docs/adr/2026-10-16-connect-time-outbound-address-checks.md), which refuses a denied address and every redirect.

const logger = createLogger("recipe-page-fetch");

/** The readable text sent to the model is cut at this many characters. */
const MAX_PAGE_TEXT_CHARS = 30_000;

/** Why a request for a page or an image ended without a body the caller can use. */
export type RecipeFetchFailure = "unreachable" | "timeout" | "status" | "contentType" | "tooLarge";

/** Every failure of `fetchCapped`. Only the reason is carried: the URL and the response are the person's content. */
export class RecipeFetchError extends Error {
  readonly reason: RecipeFetchFailure;

  constructor(reason: RecipeFetchFailure, options?: ErrorOptions) {
    super(`The request failed: ${reason}`, options);
    this.name = "RecipeFetchError";
    this.reason = reason;
  }
}

export interface FetchCappedOptions {
  /** The value of the `Accept` header. */
  accept: string;
  /** The media types (lower case, without parameters) the response may have. */
  contentTypes: readonly string[];
  /** The most bytes of the body that are read; a larger one is `tooLarge`. */
  maxBytes: number;
  /** The deadline of the whole request, the body included. */
  timeoutMs: number;
}

/** The first `https:` URL in `text`, without the punctuation of the sentence around it, or `null`. */
export function findHttpsUrl(text: string): string | null {
  const match = /https:\/\/[^\s<>"'`]+/i.exec(text);
  if (!match) return null;
  return match[0].replace(/[.,;:!?)\]}]+$/, "");
}

/** Releases a response body that is not read to its end; a failure to do so is logged by its name and dropped. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch (error) {
    // The body is being thrown away; a stream that cannot be cancelled is already closed or failed.
    logger.warn({ errName: error instanceof Error ? error.name : "unknown" }, "A response body could not be cancelled");
  }
}

/** Cancels `reader` to release the connection; a failure to do so is logged by its name and dropped. */
async function cancelReader(reader: ReadableStreamDefaultReader): Promise<void> {
  try {
    await reader.cancel();
  } catch (error) {
    // The body is being thrown away; a stream that cannot be cancelled is already closed or failed.
    logger.warn(
      { errName: error instanceof Error ? error.name : "unknown" },
      "A response reader could not be cancelled",
    );
  }
}

/** The whole body when it holds at most `maxBytes`; a larger body is cancelled at the cap and is `tooLarge`. */
async function readCappedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    let result: { done: boolean; value?: unknown };
    try {
      result = await reader.read();
    } catch (error) {
      // A body that errors part way is an unreachable page, and one cut by the deadline a timeout; the failed stream
      // has nothing left to release.
      throw new RecipeFetchError(signal.aborted ? "timeout" : "unreachable", { cause: error });
    }
    if (result.done) break;
    // The body of a response is a stream of bytes; anything else is not a page.
    if (!(result.value instanceof Uint8Array)) {
      await cancelReader(reader);
      throw new RecipeFetchError("unreachable");
    }
    size += result.value.byteLength;
    if (size > maxBytes) {
      await cancelReader(reader);
      throw new RecipeFetchError("tooLarge");
    }
    chunks.push(Buffer.from(result.value));
  }
  return Buffer.concat(chunks);
}

/**
 * Requests `url` with `fetchLike` and returns the body and its media type. The request has a deadline that covers the
 * body, a `Content-Length` over the cap and a body that grows past it are `tooLarge` (the stream is cancelled at the
 * cap, never buffered whole), a status outside 2xx is `status` and a media type outside `options.contentTypes` is
 * `contentType`; any failure of the request itself is `unreachable`, or `timeout` when the deadline ended it. A
 * redirect is a failure of `fetchLike`, which the outbound client never follows. The body is released on every path.
 */
export async function fetchCapped(
  fetchLike: OutboundHttp["fetch"],
  url: string,
  options: FetchCappedOptions,
): Promise<{ bytes: Buffer; contentType: string }> {
  const signal = AbortSignal.timeout(options.timeoutMs);
  let response: Response;
  try {
    response = await fetchLike(url, { method: "GET", headers: { accept: options.accept }, signal });
  } catch (error) {
    // Every failure of the request, a refused address included, is "the page could not be read".
    throw new RecipeFetchError(signal.aborted ? "timeout" : "unreachable", { cause: error });
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const declaredLength = Number(response.headers.get("content-length"));
  const refusal: RecipeFetchFailure | null = !response.ok
    ? "status"
    : !options.contentTypes.includes(contentType)
      ? "contentType"
      : Number.isFinite(declaredLength) && declaredLength > options.maxBytes
        ? "tooLarge"
        : null;
  if (refusal !== null) {
    await discardBody(response);
    throw new RecipeFetchError(refusal);
  }
  return { bytes: await readCappedBody(response, options.maxBytes, signal), contentType };
}

function decodeEntities(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

/** The `content` of the `<meta property="og:image">` tag of `html`, resolved against `pageUrl`, or `null`. */
function findImageUrl(html: string, pageUrl: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/\bproperty\s*=\s*["']og:image["']/i.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const value = content?.[1] ?? content?.[2];
    if (value === undefined || value.trim() === "") continue;
    try {
      return new URL(decodeEntities(value.trim()), pageUrl).href;
    } catch {
      // A `content` that is not a URL names no image; the next tag may.
      continue;
    }
  }
  return null;
}

/** The tags that start a new line of text: the text on either side of one is never one word. */
const BLOCK_TAG =
  /<(\/?)(p|div|br|hr|li|ul|ol|dl|dt|dd|h[1-6]|tr|td|th|table|section|article|header|footer|blockquote|pre)\b/gi;

/**
 * What a page says, for the model: its visible text (every tag, script and style removed, entities decoded, whitespace
 * collapsed, cut at `MAX_PAGE_TEXT_CHARS`) and the image its `og:image` tag names as an absolute URL, or `null`.
 */
export function readPage(html: string, pageUrl: string): { text: string; imageUrl: string | null } {
  // Stripping a tag leaves no space behind, so a space goes in front of every block tag first.
  const spaced = html.replace(BLOCK_TAG, " <$1$2");
  const text = decodeEntities(htmlToPlainText(spaced)).replace(/\s+/g, " ").trim().slice(0, MAX_PAGE_TEXT_CHARS);
  return { text, imageUrl: findImageUrl(html, pageUrl) };
}
