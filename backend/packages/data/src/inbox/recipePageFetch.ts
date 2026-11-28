import { createLogger } from "@alldots/shared";
import { htmlToPlainText } from "../mail/mailPlainText.js";
import type { OutboundHttp } from "../net/outboundAddressPolicy.js";

// Reading a page a person pasted into the Inbox: timeout, size cap, content-type allow-list and readable text. The
// outbound address policy lives in the caller's `fetch` (`createOutboundHttp().fetch`), which refuses denied
// addresses and every redirect.

const logger = createLogger("recipe-page-fetch");

const MAX_PAGE_TEXT_CHARS = 30_000;

export type RecipeFetchFailure = "unreachable" | "timeout" | "status" | "contentType" | "tooLarge";

/** Only the reason is carried: the URL and the response are the person's content. */
export class RecipeFetchError extends Error {
  readonly reason: RecipeFetchFailure;

  constructor(reason: RecipeFetchFailure, options?: ErrorOptions) {
    super(`The request failed: ${reason}`, options);
    this.name = "RecipeFetchError";
    this.reason = reason;
  }
}

export interface FetchCappedOptions {
  accept: string;
  /** Lower case, without parameters. */
  contentTypes: readonly string[];
  /** A larger body is `tooLarge`. */
  maxBytes: number;
  timeoutMs: number;
}

/** The first `https:` URL in `text`, without surrounding sentence punctuation, or `null`. */
export function findHttpsUrl(text: string): string | null {
  const match = /https:\/\/[^\s<>"'`]+/i.exec(text);
  if (!match) return null;
  return match[0].replace(/[.,;:!?)\]}]+$/, "");
}

/** Releases an unread response body; a failure is logged by name and dropped. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch (error) {
    // The body is being thrown away; a stream that cannot be cancelled is already closed or failed.
    logger.warn({ errName: error instanceof Error ? error.name : "unknown" }, "A response body could not be cancelled");
  }
}

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
      // A body erroring part way is unreachable, or a timeout when the deadline cut it; it has nothing left to release.
      throw new RecipeFetchError(signal.aborted ? "timeout" : "unreachable", { cause: error });
    }
    if (result.done) break;
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
 * Requests `url` with a deadline covering the body. A `Content-Length` or body over the cap is `tooLarge` (cancelled
 * at the cap, never buffered whole), non-2xx is `status`, a disallowed media type `contentType`, any request failure
 * (redirects included, which the outbound client refuses) `unreachable` or `timeout`. The body is released on every
 * path.
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

/** Tags that start a new line of text: the text on either side is never one word. */
const BLOCK_TAG =
  /<(\/?)(p|div|br|hr|li|ul|ol|dl|dt|dd|h[1-6]|tr|td|th|table|section|article|header|footer|blockquote|pre)\b/gi;

/** A page's visible text for the model (cut at `MAX_PAGE_TEXT_CHARS`) and its absolute `og:image` URL, or `null`. */
export function readPage(html: string, pageUrl: string): { text: string; imageUrl: string | null } {
  // Stripping a tag leaves no space behind, so a space goes in front of every block tag first.
  const spaced = html.replace(BLOCK_TAG, " <$1$2");
  const text = decodeEntities(htmlToPlainText(spaced)).replace(/\s+/g, " ").trim().slice(0, MAX_PAGE_TEXT_CHARS);
  return { text, imageUrl: findImageUrl(html, pageUrl) };
}
