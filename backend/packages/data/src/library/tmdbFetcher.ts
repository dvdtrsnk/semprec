import { z } from "zod";
import type { ItemRow } from "../types.js";
import type { LibraryMetadataFetchResult } from "./libraryMetadataJob.js";
import {
  downloadLibraryCover,
  fetchLibraryJson,
  rankLibraryMatch,
  type LibraryCoverDownload,
  type LibraryHttpFetch,
} from "./openLibraryFetcher.js";

const mediaSchema = z.object({
  id: z.number().int().positive(),
  media_type: z.enum(["movie", "tv"]),
  title: z.string().optional(),
  name: z.string().optional(),
  release_date: z.string().optional(),
  first_air_date: z.string().optional(),
  poster_path: z.string().nullable().optional(),
});
const searchSchema = z.object({ results: z.array(z.unknown()) });
const detailsSchema = z.object({
  vote_average: z.number().min(0).max(10),
  vote_count: z.number().int().nonnegative(),
});

export async function fetchTmdb(
  item: ItemRow,
  fetcher: LibraryHttpFetch,
  token: string | undefined,
  coverDownload: LibraryCoverDownload = downloadLibraryCover,
): Promise<LibraryMetadataFetchResult> {
  if (!token) return { status: "error", errorCode: "sourceUnavailable", source: "tmdb" };
  if (typeof item.properties.name !== "string" || item.properties.name.trim() === "")
    return { status: "notFound", source: "tmdb" };
  const headers = { authorization: `Bearer ${token}` };
  const year = item.properties.year;
  const searches: Array<{ endpoint: "multi" | "movie" | "tv"; yearKey?: string }> =
    typeof year === "number" && Number.isFinite(year)
      ? [
          { endpoint: "movie", yearKey: "primary_release_year" },
          { endpoint: "tv", yearKey: "first_air_date_year" },
        ]
      : [{ endpoint: "multi" }];
  const docs: Array<{ id: number; kind: "movie" | "tv"; title: string; year?: number; coverUrl?: string }> = [];
  for (const search of searches) {
    const url = new URL(`https://api.themoviedb.org/3/search/${search.endpoint}`);
    url.searchParams.set("query", item.properties.name);
    if (search.yearKey) url.searchParams.set(search.yearKey, String(year));
    const response = await fetchLibraryJson(fetcher, url.toString(), { headers });
    if ("error" in response) return { status: "error", errorCode: response.error, source: "tmdb" };
    const parsed = searchSchema.safeParse(response.value);
    if (!parsed.success) return { status: "error", errorCode: "invalidResponse", source: "tmdb" };
    for (const raw of parsed.data.results) {
      if (
        search.endpoint === "multi" &&
        typeof raw === "object" &&
        raw !== null &&
        "media_type" in raw &&
        raw.media_type === "person"
      )
        continue;
      const input =
        search.endpoint !== "multi" && typeof raw === "object" && raw !== null
          ? { ...raw, media_type: search.endpoint }
          : raw;
      const media = mediaSchema.safeParse(input);
      if (!media.success) return { status: "error", errorCode: "invalidResponse", source: "tmdb" };
      const title = media.data.media_type === "movie" ? media.data.title : media.data.name;
      if (!title) return { status: "error", errorCode: "invalidResponse", source: "tmdb" };
      const date = media.data.media_type === "movie" ? media.data.release_date : media.data.first_air_date;
      const year = /^\d{4}/.exec(date ?? "")?.[0];
      docs.push({
        id: media.data.id,
        kind: media.data.media_type,
        title,
        year: year ? Number(year) : undefined,
        coverUrl:
          media.data.poster_path && /^\/[a-z0-9_-]+\.(?:jpg|png|webp)$/i.test(media.data.poster_path)
            ? `https://image.tmdb.org/t/p/w500${media.data.poster_path}`
            : undefined,
      });
    }
  }
  docs.sort(
    (a, b) => rankLibraryMatch(item, b.title, undefined, b.year) - rankLibraryMatch(item, a.title, undefined, a.year),
  );
  const best = docs[0];
  if (!best) return { status: "notFound", source: "tmdb" };
  const details = await fetchLibraryJson(fetcher, `https://api.themoviedb.org/3/${best.kind}/${best.id}`, { headers });
  if ("error" in details) return { status: "error", errorCode: details.error, source: "tmdb" };
  const detail = detailsSchema.safeParse(details.value);
  if (!detail.success) return { status: "error", errorCode: "invalidResponse", source: "tmdb" };
  return {
    status: "found",
    source: "tmdb",
    year: best.year,
    type: best.kind === "tv" ? "series" : "movie",
    secondaryRating: detail.data.vote_count > 0 ? Math.round(detail.data.vote_average * 10) : undefined,
    sourceUrl: `https://www.themoviedb.org/${best.kind}/${best.id}`,
    cover: best.coverUrl ? await coverDownload(best.coverUrl) : undefined,
    candidates: docs.slice(1, 4).map(({ title, year, coverUrl }) => ({ title, year, coverUrl })),
  };
}
