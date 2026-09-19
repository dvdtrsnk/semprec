import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioProviderCallError } from "../types.js";
import { createPyannoteDiarizationProvider } from "../pyannoteProvider.js";

describe("createPyannoteDiarizationProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("submits a URL and normalizes the completed job's turns", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
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

    const pending = createPyannoteDiarizationProvider("test-key").diarize({
      audioUrl: "https://audio.example/meeting.opus",
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual([{ speaker: "SPEAKER_00", start: 1, end: 2.5 }]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.pyannote.ai/v1/diarize",
      expect.objectContaining({ body: JSON.stringify({ url: "https://audio.example/meeting.opus" }) }),
    );
  });

  it("fails when pyannoteAI rejects job creation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider detail", { status: 400 })));

    await expect(
      createPyannoteDiarizationProvider("test-key").diarize({ audioUrl: "https://audio.example/meeting.opus" }),
    ).rejects.toBeInstanceOf(AudioProviderCallError);
  });
});
