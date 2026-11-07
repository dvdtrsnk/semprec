import "../domainWriteHooks.js";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { withTransaction } from "../db/pool.js";
import { getItemAutomation } from "../library/itemAutomationStore.js";
import { enqueueLibraryMetadataProcessing } from "../library/libraryMetadataJob.js";
import { createLibraryMetadataFetcher } from "../library/libraryMetadataFetcher.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createCoreTaskList } from "../worker.js";
import type { ItemRow } from "../types.js";
import { fetchTmdb } from "../library/tmdbFetcher.js";

const item: ItemRow = {
  id: "item",
  databaseId: "movies",
  properties: { name: "Duna: Část druhá", year: 2024 },
  computed: {},
  createdAt: "2026-01-01T00:00:00Z",
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })))
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
    expect(fetcher.mock.calls[0]?.[0]).toContain(
      "/search/movie?query=Duna%3A+%C4%8C%C3%A1st+druh%C3%A1&primary_release_year=2024",
    );
    expect(fetcher.mock.calls[1]?.[0]).toContain(
      "/search/tv?query=Duna%3A+%C4%8C%C3%A1st+druh%C3%A1&first_air_date_year=2024",
    );
  });
  it("maps series and omits rating when no votes exist", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })))
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

  it("uses multi-search without a year and merges year-filtered movie and TV pages when present", async () => {
    const withoutYear: ItemRow = { ...item, properties: { name: "Duna: Část druhá" } };
    const multi = vi.fn(async (_url: string) => new Response(JSON.stringify({ results: [] })));
    expect(await fetchTmdb(withoutYear, multi, "test-token")).toMatchObject({ status: "notFound" });
    expect(multi).toHaveBeenCalledOnce();
    expect(multi.mock.calls[0]?.[0]).toContain("/search/multi?");

    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ id: 1, title: "Duna: Část druhá", release_date: "2021-01-01" }] })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ id: 2, name: "Duna: Část druhá", first_air_date: "2024-01-01" }] })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ vote_average: 8, vote_count: 10 })));
    const result = await fetchTmdb(item, fetcher, "test-token");
    expect(result).toMatchObject({
      status: "found",
      type: "series",
      year: 2024,
      sourceUrl: "https://www.themoviedb.org/tv/2",
    });
    expect(result.candidates).toEqual([expect.objectContaining({ title: "Duna: Část druhá", year: 2021 })]);
    expect(fetcher.mock.calls[2]?.[0]).toBe("https://api.themoviedb.org/3/tv/2");
  });

  it("does not use partial results when a required year-search endpoint fails or is malformed", async () => {
    const valid = () =>
      new Response(JSON.stringify({ results: [{ id: 1, title: "Duna", release_date: "2024-01-01" }] }));
    for (const failed of [new Response(null, { status: 429 }), new Response(JSON.stringify({ results: "invalid" }))]) {
      const fetcher = vi.fn().mockResolvedValueOnce(valid()).mockResolvedValueOnce(failed);
      const result = await fetchTmdb(item, fetcher, "test-token");
      expect(result).toMatchObject({
        status: "error",
        errorCode: failed.status === 429 ? "rateLimited" : "invalidResponse",
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    const empty = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] })));
    expect(await fetchTmdb(item, empty, "test-token")).toMatchObject({ status: "notFound" });
    expect(empty).toHaveBeenCalledTimes(2);
  });

  it("keeps the TMDB token out of a real queued 401 outcome and worker logs", async () => {
    const admin = getTestPool();
    const runtime = await createRuntimeRolePool(admin, "semprec_data");
    const failures: unknown[] = [];
    try {
      await resetDatabase(admin);
      const role = await runAsSystem("check TMDB test role", () =>
        runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const tenant = await createTestTenant(admin);
      await runInTenant(tenant, () => seedSystem(runtime));
      const token = "tmdb-private-fixture-token";
      const responseSecret = "tmdb-private-response-secret";
      const cp = createChokePoint(runtime);
      const fixture = await runInTenant(tenant, async () => {
        const movies = (await cp.listDatabases()).find((db) => db.ownerModuleId === "movies");
        if (!movies) throw new Error("Movies database missing");
        const movie = await cp.createItem({ databaseId: movies.id, properties: { name: "Fixture" } });
        await withTransaction(runtime, (client) =>
          enqueueLibraryMetadataProcessing(client, {
            databaseId: movies.id,
            itemId: movie.id,
            config: { source: "tmdb", coverKey: "cover" },
          }),
        );
        return movie;
      });
      const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(responseSecret, { status: 401 }));
      const taskName = CORE_TASK_NAMES.LIBRARY_METADATA_PROCESS;
      const task = createCoreTaskList(
        runtime,
        new Map(),
        createLibraryMetadataFetcher({ fetch: fetcher, tmdbToken: token }),
      )[taskName];
      if (!task) throw new Error("Library task missing");
      const errorLog = vi.spyOn(console, "error");
      let captured: string;
      try {
        await runOnce({ pgPool: runtime, taskList: { [taskName]: task } });
        captured = inspect(errorLog.mock.calls, { depth: 8 });
      } finally {
        errorLog.mockRestore();
      }
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { authorization: `Bearer ${token}` } });
      expect(captured).toContain("Library metadata processing failed");
      expect(captured).not.toContain(token);
      expect(captured).not.toContain(responseSecret);
      const automation = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) => getItemAutomation(client, fixture.id)),
      );
      expect(automation).toMatchObject({
        status: "error",
        errorCode: "sourceUnavailable",
        source: "tmdb",
        attempts: 1,
        error: "Library metadata processing failed",
      });
      expect(JSON.stringify(automation)).not.toContain(token);
      expect(JSON.stringify(automation)).not.toContain(responseSecret);
    } catch (error) {
      failures.push(error);
    }
    for (const close of [() => runtime.end(), () => admin.end()]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "TMDB worker test and cleanup failed");
  });
});
