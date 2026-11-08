import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

const { loadModuleCatalogs } = vi.hoisted(() => ({ loadModuleCatalogs: vi.fn() }));

vi.mock("@semprec/module-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@semprec/module-registry")>();
  loadModuleCatalogs.mockImplementation(actual.loadModuleCatalogs);
  return { ...actual, loadModuleCatalogs };
});

vi.mock("../../db/pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db/pool.js")>()),
  withTransaction: vi.fn(async () => [{ speaker: "SPEAKER_00", ordinal: 1, person: null }]),
}));

const { createTranscriptSpeakersRouteHandler } = await import("../transcriptionRouteHandlers.js");

/** `GET /api/transcripts/:id/speakers` must not keep failing after one failed catalog load. */
describe("Transcript speakers route catalog loading", () => {
  it("retries a failed catalog load on the next request instead of caching the rejection", async () => {
    const handler = createTranscriptSpeakersRouteHandler({} as Pool);
    const ctx = { params: { id: "00000000-0000-4000-8000-000000000001" }, identity: { user: { locale: "en" } } };
    loadModuleCatalogs.mockRejectedValueOnce(new Error("catalog missing"));

    await expect(handler(ctx)).rejects.toThrow("catalog missing");
    expect(await handler(ctx)).toEqual({
      status: 200,
      body: { speakers: [{ speaker: "SPEAKER_00", label: "Speaker 1", personId: null }] },
    });
    expect(loadModuleCatalogs).toHaveBeenCalledTimes(2);
  });
});
