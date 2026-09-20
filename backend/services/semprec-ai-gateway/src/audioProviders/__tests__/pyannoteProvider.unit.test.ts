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

  describe("SSRF guard on audioUrl", () => {
    const fetchMock = vi.fn();

    afterEach(() => {
      fetchMock.mockReset();
    });

    const rejects = async (audioUrl: string) => {
      vi.stubGlobal("fetch", fetchMock);
      await expect(createPyannoteDiarizationProvider("test-key").diarize({ audioUrl })).rejects.toBeInstanceOf(
        AudioProviderCallError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    };

    it("rejects a non-https URL", () => rejects("http://audio.example/meeting.opus"));
    it("rejects localhost", () => rejects("https://localhost/meeting.opus"));
    it("rejects a .internal host", () => rejects("https://host.internal/meeting.opus"));
    it("rejects a literal private IPv4 address", () => rejects("https://192.168.1.5/meeting.opus"));
    it("rejects a literal loopback IPv4 address", () => rejects("https://127.0.0.1/meeting.opus"));
    it("rejects a literal IPv6 loopback address", () => rejects("https://[::1]/meeting.opus"));
    it("rejects an IPv4-mapped IPv6 loopback address", () => rejects("https://[::ffff:127.0.0.1]/meeting.opus"));
    it("rejects an IPv4-mapped IPv6 private address", () => rejects("https://[::ffff:192.168.1.5]/meeting.opus"));
    it("rejects the fe80:: literal IPv6 link-local address", () => rejects("https://[fe80::1]/meeting.opus"));
    it("rejects an fe80::/10 IPv6 link-local address outside the fe80 literal prefix", () =>
      rejects("https://[febf::1]/meeting.opus"));
  });
});
