import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioProviderCallError } from "../types.js";
import { createPyannoteDiarizationProvider } from "../pyannoteProvider.js";

const REQUEST = { audio: new Uint8Array([1, 2, 3]), filename: "recording.opus", mimeType: "audio/ogg" };

describe("createPyannoteDiarizationProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uploads the audio, submits its media key, and normalizes the completed job's turns", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://upload.example/presigned" })))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: "job-1" })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "succeeded",
            output: { diarization: [{ speaker: "SPEAKER_00", start: 1, end: 2.5, confidence: { ignored: 1 } }] },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = createPyannoteDiarizationProvider("test-key").diarize(REQUEST);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual([{ speaker: "SPEAKER_00", start: 1, end: 2.5 }]);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://api.pyannote.ai/v1/media/input", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://upload.example/presigned",
      expect.objectContaining({ method: "PUT", body: REQUEST.audio }),
    );
    const diarizeCall = fetchMock.mock.calls[2];
    expect(diarizeCall?.[0]).toBe("https://api.pyannote.ai/v1/diarize");
    const diarizeBody = JSON.parse((diarizeCall?.[1] as { body: string }).body) as { url: string };
    expect(diarizeBody.url).toMatch(/^media:\/\/semprec-/);
  });

  it("fails when the media upload request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider detail", { status: 400 })));

    await expect(createPyannoteDiarizationProvider("test-key").diarize(REQUEST)).rejects.toBeInstanceOf(
      AudioProviderCallError,
    );
  });

  it("fails when the presigned PUT upload fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://upload.example/presigned" })))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPyannoteDiarizationProvider("test-key").diarize(REQUEST)).rejects.toBeInstanceOf(
      AudioProviderCallError,
    );
  });

  it("fails when pyannoteAI rejects job creation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://upload.example/presigned" })))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response("provider detail", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPyannoteDiarizationProvider("test-key").diarize(REQUEST)).rejects.toBeInstanceOf(
      AudioProviderCallError,
    );
  });

  it("rejects a diarization turn whose end precedes its start", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: "https://upload.example/presigned" })))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: "job-1" })))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "succeeded",
            output: { diarization: [{ speaker: "SPEAKER_00", start: 5, end: 2 }] },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = createPyannoteDiarizationProvider("test-key").diarize(REQUEST);
    // Attach the rejection assertion before advancing timers, so `pending` has a handler in
    // place the instant it rejects rather than for one unobserved microtask turn.
    const assertion = expect(pending).rejects.toBeInstanceOf(AudioProviderCallError);
    await vi.advanceTimersByTimeAsync(1_000);

    await assertion;
  });
});
