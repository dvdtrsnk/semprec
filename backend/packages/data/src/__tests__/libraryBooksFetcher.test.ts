import { describe, expect, it, vi } from "vitest";
import type { ItemRow } from "../types.js";
import { downloadLibraryCover, fetchOpenLibrary, type LibraryHttpFetch } from "../library/openLibraryFetcher.js";
import { createLibraryMetadataFetcher } from "../library/libraryMetadataFetcher.js";
import { fetchGoogleBooks } from "../library/googleBooksFetcher.js";

const item: ItemRow = {
  id: "item",
  databaseId: "books",
  properties: { name: "Hovory k sobě", author: "Marcus Aurelius", year: 180 },
  computed: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

function fixture(value: unknown, status = 200): LibraryHttpFetch {
  return async () => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("library book source responses", () => {
  it("chooses the exact title and author, returns metadata and at most three alternatives", async () => {
    const result = await fetchOpenLibrary(
      item,
      fixture({
        docs: [
          { title: "Other", author_name: ["Someone"] },
          {
            title: "Hovory k sobě",
            author_name: ["Marcus Aurelius"],
            first_publish_year: 180,
            isbn: ["9780000000000"],
          },
          { title: "Other 2" },
          { title: "Other 3" },
          { title: "Other 4" },
        ],
      }),
    );
    expect(result).toMatchObject({
      status: "found",
      source: "openLibrary",
      author: "Marcus Aurelius",
      year: 180,
      isbn: "9780000000000",
    });
    expect(result.candidates).toHaveLength(3);
  });

  it("maps no results, malformed data, unavailable and rate limited responses", async () => {
    expect(await fetchOpenLibrary(item, fixture({ docs: [] }))).toMatchObject({ status: "notFound" });
    expect(await fetchOpenLibrary(item, fixture({ docs: "invalid" }))).toMatchObject({
      status: "error",
      errorCode: "invalidResponse",
    });
    expect(await fetchOpenLibrary(item, fixture({}, 503))).toMatchObject({
      status: "error",
      errorCode: "sourceUnavailable",
    });
    expect(await fetchOpenLibrary(item, fixture({}, 429))).toMatchObject({ status: "error", errorCode: "rateLimited" });
  });

  it("rejects non-JSON and an oversized response", async () => {
    const nonJson: LibraryHttpFetch = async () => new Response("not json");
    const oversized: LibraryHttpFetch = async () => new Response("x".repeat(1024 * 1024 + 1));
    expect(await fetchOpenLibrary(item, nonJson)).toMatchObject({ status: "error", errorCode: "invalidResponse" });
    expect(await fetchOpenLibrary(item, oversized)).toMatchObject({ status: "error", errorCode: "invalidResponse" });
  });

  it("returns an empty result for a disabled source without a provider request", async () => {
    const fetcher = vi.fn(async () => new Response("unexpected", { status: 500 }));
    const result = await createLibraryMetadataFetcher({ fetch: fetcher })(item, {
      source: "none",
      coverKey: "cover",
    });
    expect(result).toEqual({});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("aborts an unresponsive provider at the configured deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetcher: LibraryHttpFetch = async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) throw new Error("Missing provider signal");
          init.signal.addEventListener("abort", () => reject(new Error("fixture aborted")), { once: true });
        });
      const pending = fetchOpenLibrary(item, fetcher);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toMatchObject({ status: "error", errorCode: "sourceUnavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "https://169.254.169.254/latest",
    "https://10.0.0.1/cover.jpg",
    "https://user:secret@example.com/cover.jpg",
  ])("refuses a non-public or credential-bearing cover URL", async (url) => {
    expect(await downloadLibraryCover(url)).toBeUndefined();
  });

  it("falls back to Google Books when Open Library has no match", async () => {
    const requests: string[] = [];
    const fetcher: LibraryHttpFetch = async (url) => {
      requests.push(url);
      return url.startsWith("https://openlibrary.org/")
        ? new Response(JSON.stringify({ docs: [] }))
        : new Response(
            JSON.stringify({
              kind: "books#volumes",
              totalItems: 1,
              items: [{ volumeInfo: { title: "Hovory k sobě", authors: ["Marcus Aurelius"] } }],
            }),
          );
    };
    const result = await createLibraryMetadataFetcher({ fetch: fetcher })(item, {
      source: "openLibrary",
      coverKey: "cover",
    });
    expect(result).toMatchObject({ status: "found", source: "googleBooks", author: "Marcus Aurelius" });
    expect(requests).toHaveLength(2);
  });

  it("reads a Google Books match and its source", async () => {
    expect(
      await fetchGoogleBooks(
        item,
        fixture({
          kind: "books#volumes",
          totalItems: 1,
          items: [
            {
              volumeInfo: {
                title: "Hovory k sobě",
                authors: ["Marcus Aurelius"],
                publishedDate: "0180",
                industryIdentifiers: [{ type: "ISBN_13", identifier: "9780000000000" }],
              },
            },
          ],
        }),
      ),
    ).toMatchObject({
      status: "found",
      source: "googleBooks",
      author: "Marcus Aurelius",
      year: 180,
      isbn: "9780000000000",
    });
  });

  it("distinguishes a valid empty Google response from malformed successful bodies", async () => {
    expect(await fetchGoogleBooks(item, fixture({ kind: "books#volumes", totalItems: 0 }))).toMatchObject({
      status: "notFound",
      source: "googleBooks",
    });
    expect(await fetchGoogleBooks(item, fixture({ kind: "books#volumes", totalItems: 0, items: [] }))).toMatchObject({
      status: "notFound",
      source: "googleBooks",
    });
    for (const body of [
      {},
      { error: "provider failure" },
      { kind: "books#volumes", totalItems: "0" },
      { kind: "books#volumes", totalItems: 3 },
      { kind: "books#volumes", totalItems: 3, items: [] },
    ]) {
      expect(await fetchGoogleBooks(item, fixture(body))).toMatchObject({
        status: "error",
        errorCode: "invalidResponse",
        source: "googleBooks",
      });
    }
    expect(
      await fetchGoogleBooks(
        item,
        fixture({
          kind: "books#volumes",
          totalItems: 1,
          items: [{ volumeInfo: { title: "First" } }, { volumeInfo: { title: "Second" } }],
        }),
      ),
    ).toMatchObject({ status: "found", source: "googleBooks" });
  });
});
