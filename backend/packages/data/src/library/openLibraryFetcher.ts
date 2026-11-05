import { z } from "zod";
import { createOutboundHttp } from "../net/outboundAddressPolicy.js";
import { createLogger } from "@semprec/shared";

import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";
import { MAX_LIBRARY_COVER_BYTES, type DownloadedLibraryCover } from "./libraryCoverStorage.js";
import type { ItemRow } from "../types.js";
import type { LibraryMetadataFetchResult } from "./libraryMetadataJob.js";

const logger = createLogger("library-metadata");

const documentSchema = z.object({
  title: z.string(),
  author_name: z.array(z.string()).optional(),
  first_publish_year: z.number().int().optional(),
  isbn: z.array(z.string()).optional(),
  cover_i: z.number().int().optional(),
});
const responseSchema = z.object({ docs: z.array(documentSchema) });

export type LibraryHttpFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type LibraryFetchError = "sourceUnavailable" | "rateLimited" | "invalidResponse";

/** Bounded JSON response for fixed provider endpoints. */
export async function fetchLibraryJson(
  fetcher: LibraryHttpFetch,
  url: string,
  init?: RequestInit,
): Promise<{ value: unknown } | { error: LibraryFetchError }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      return { error: response.status === 429 ? "rateLimited" : "sourceUnavailable" };
    }
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
    if (!reader) return { error: "invalidResponse" };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024 * 1024) {
          await reader.cancel();
          return { error: "invalidResponse" };
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
    } catch {
      return { error: "invalidResponse" };
    }
  } catch {
    return { error: "sourceUnavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

export type LibraryCoverDownload = (url: string) => Promise<DownloadedLibraryCover | undefined>;

/** Fetches provider-supplied image URLs through the connect-time address policy. */
export async function downloadLibraryCover(url: string): Promise<DownloadedLibraryCover | undefined> {
  if (!isBaselineOutboundUrl(url)) return undefined;
  const outbound = createOutboundHttp();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await outbound.fetch(url, { signal: controller.signal, redirect: "error" });
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!response.ok || !mimeType?.startsWith("image/")) {
      await response.body?.cancel();
      return undefined;
    }
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > MAX_LIBRARY_COVER_BYTES) {
          await reader.cancel();
          return undefined;
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (length === 0) return undefined;
    return { bytes: Buffer.concat(chunks), mimeType };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    try {
      await outbound.close();
    } catch {
      logger.error("Failed to close library cover HTTP client");
    }
  }
}

export function rankLibraryMatch(item: ItemRow, title: string, author?: string, year?: number): number {
  const normalize = (value: string) => value.trim().toLowerCase();
  let score = typeof item.properties.name === "string" && normalize(item.properties.name) === normalize(title) ? 4 : 0;
  if (typeof item.properties.author === "string" && author && normalize(item.properties.author) === normalize(author))
    score += 2;
  if (typeof item.properties.year === "number" && item.properties.year === year) score++;
  return score;
}

export async function fetchOpenLibrary(
  item: ItemRow,
  fetcher: LibraryHttpFetch,
  coverDownload: LibraryCoverDownload = downloadLibraryCover,
): Promise<LibraryMetadataFetchResult> {
  if (typeof item.properties.name !== "string" || item.properties.name.trim() === "")
    return { status: "notFound", source: "openLibrary" };
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("title", item.properties.name);
  if (typeof item.properties.author === "string" && item.properties.author)
    url.searchParams.set("author", item.properties.author);
  url.searchParams.set("limit", "10");
  const response = await fetchLibraryJson(fetcher, url.toString());
  if ("error" in response) return { status: "error", errorCode: response.error, source: "openLibrary" };
  const parsed = responseSchema.safeParse(response.value);
  if (!parsed.success) return { status: "error", errorCode: "invalidResponse", source: "openLibrary" };
  const docs = parsed.data.docs.map((doc) => ({
    title: doc.title,
    author: doc.author_name?.[0],
    year: doc.first_publish_year,
    isbn: doc.isbn?.[0],
    coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : undefined,
  }));
  docs.sort(
    (a, b) => rankLibraryMatch(item, b.title, b.author, b.year) - rankLibraryMatch(item, a.title, a.author, a.year),
  );
  const best = docs[0];
  if (!best) return { status: "notFound", source: "openLibrary" };
  return {
    status: "found",
    source: "openLibrary",
    author: best.author,
    year: best.year,
    isbn: best.isbn,
    cover: best.coverUrl ? await coverDownload(best.coverUrl) : undefined,
    candidates: docs.slice(1, 4).map(({ title, author, year, coverUrl }) => ({ title, author, year, coverUrl })),
  };
}
