import { describe, expect, it, vi } from "vitest";
import type { ItemRow } from "../types.js";
import { fetchTmdb } from "../library/tmdbFetcher.js";

const item: ItemRow = {
  id: "item",
  databaseId: "movies",
  properties: { name: "Duna: Část druhá", year: 2024 },
  computed: {},
  updatedAt: "2026-01-01T00:00:00Z",
  deletedAt: null,
};

describe("TMDB response mapping", () => {
  it("maps the best movie result and its details", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ id: 1, media_type: "movie", title: "Duna: Část druhá", release_date: "2024-02-28" }],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ vote_average: 7.9, vote_count: 30 })));
    expect(await fetchTmdb(item, fetcher, "test-token")).toMatchObject({
      status: "found",
      source: "tmdb",
      year: 2024,
      type: "movie",
      secondaryRating: 79,
      sourceUrl: "https://www.themoviedb.org/movie/1",
    });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: "Bearer test-token" } });
  });
  it("maps series and omits rating when no votes exist", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ id: 2, media_type: "tv", name: "Duna: Část druhá", first_air_date: "2024-01-01" }],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ vote_average: 0, vote_count: 0 })));
    expect(await fetchTmdb(item, fetcher, "test-token")).toMatchObject({
      status: "found",
      type: "series",
      secondaryRating: undefined,
    });
  });
  it("refuses missing token without a request and sanitizes provider errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("secret-token", { status: 401 }));
    expect(await fetchTmdb(item, fetcher, undefined)).toMatchObject({
      status: "error",
      errorCode: "sourceUnavailable",
    });
    expect(fetcher).not.toHaveBeenCalled();
    const result = await fetchTmdb(item, fetcher, "secret-token");
    expect(result).toMatchObject({ status: "error", errorCode: "sourceUnavailable" });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
  it("maps rate limiting", async () => {
    expect(
      await fetchTmdb(item, vi.fn().mockResolvedValue(new Response(null, { status: 429 })), "test-token"),
    ).toMatchObject({ status: "error", errorCode: "rateLimited" });
  });
});
