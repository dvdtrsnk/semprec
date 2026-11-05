import { z } from "zod";
import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";
import type { ItemRow } from "../types.js";
import type { LibraryMetadataFetchResult } from "./libraryMetadataJob.js";
import {
  downloadLibraryCover,
  fetchLibraryJson,
  rankLibraryMatch,
  type LibraryCoverDownload,
  type LibraryHttpFetch,
} from "./openLibraryFetcher.js";

const responseSchema = z.object({
  kind: z.literal("books#volumes"),
  totalItems: z.number().int().nonnegative(),
  items: z
    .array(
      z.object({
        volumeInfo: z.object({
          title: z.string(),
          authors: z.array(z.string()).optional(),
          publishedDate: z.string().optional(),
          industryIdentifiers: z.array(z.object({ type: z.string(), identifier: z.string() })).optional(),
          imageLinks: z.object({ thumbnail: z.string().optional() }).optional(),
        }),
      }),
    )
    .optional(),
});

export async function fetchGoogleBooks(
  item: ItemRow,
  fetcher: LibraryHttpFetch,
  coverDownload: LibraryCoverDownload = downloadLibraryCover,
): Promise<LibraryMetadataFetchResult> {
  if (typeof item.properties.name !== "string" || item.properties.name.trim() === "")
    return { status: "notFound", source: "googleBooks" };
  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  let query = `intitle:${item.properties.name}`;
  if (typeof item.properties.author === "string" && item.properties.author)
    query += ` inauthor:${item.properties.author}`;
  url.searchParams.set("q", query);
  url.searchParams.set("maxResults", "10");
  const response = await fetchLibraryJson(fetcher, url.toString());
  if ("error" in response) return { status: "error", errorCode: response.error, source: "googleBooks" };
  const parsed = responseSchema.safeParse(response.value);
  if (!parsed.success || (parsed.data.totalItems > 0 && !parsed.data.items?.length))
    return { status: "error", errorCode: "invalidResponse", source: "googleBooks" };
  const docs = (parsed.data.items ?? []).map(({ volumeInfo: info }) => {
    const year = /^\d{4}/.exec(info.publishedDate ?? "")?.[0];
    const thumbnail = info.imageLinks?.thumbnail;
    const downloadUrl = thumbnail && isBaselineOutboundUrl(thumbnail) ? thumbnail : undefined;
    return {
      title: info.title,
      author: info.authors?.[0],
      year: year ? Number(year) : undefined,
      isbn: info.industryIdentifiers?.find((entry) => entry.type === "ISBN_13" || entry.type === "ISBN_10")?.identifier,
      downloadUrl,
      coverUrl:
        downloadUrl && new URL(downloadUrl).search === "" && new URL(downloadUrl).hash === "" ? downloadUrl : undefined,
    };
  });
  docs.sort(
    (a, b) => rankLibraryMatch(item, b.title, b.author, b.year) - rankLibraryMatch(item, a.title, a.author, a.year),
  );
  const best = docs[0];
  if (!best) return { status: "notFound", source: "googleBooks" };
  return {
    status: "found",
    source: "googleBooks",
    author: best.author,
    year: best.year,
    isbn: best.isbn,
    cover: best.downloadUrl ? await coverDownload(best.downloadUrl) : undefined,
    candidates: docs.slice(1, 4).map(({ title, author, year, coverUrl }) => ({ title, author, year, coverUrl })),
  };
}
