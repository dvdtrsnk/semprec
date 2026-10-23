import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioProviderCallError } from "../types.js";
import { createDeepInfraWhisperProvider } from "../deepInfraWhisperProvider.js";

describe("createDeepInfraWhisperProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("normalizes DeepInfra's verbose Whisper response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ text: "Hello", language: "en", segments: [{ start: 0, end: 1.2, text: "Hello" }] }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await createDeepInfraWhisperProvider("test-key").transcribe({
      audio: new Uint8Array([1, 2]),
      filename: "chunk.opus",
      mimeType: "audio/ogg",
    });

    expect(result).toEqual({ text: "Hello", language: "en", segments: [{ start: 0, end: 1.2, text: "Hello" }] });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepinfra.com/v1/openai/audio/transcriptions",
      expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer test-key" } }),
    );
  });

  it("does not expose a provider response body on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("provider detail", { status: 429 })));

    await expect(
      createDeepInfraWhisperProvider("test-key").transcribe({
        audio: new Uint8Array(),
        filename: "chunk.opus",
        mimeType: "audio/ogg",
      }),
    ).rejects.toEqual(
      expect.objectContaining({ name: "AudioProviderCallError", message: "DeepInfra responded with HTTP 429" }),
    );
  });

  it("rejects a malformed provider shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "missing segments" }))));

    await expect(
      createDeepInfraWhisperProvider("test-key").transcribe({
        audio: new Uint8Array(),
        filename: "chunk.opus",
        mimeType: "audio/ogg",
      }),
    ).rejects.toBeInstanceOf(AudioProviderCallError);
  });

  it("passes an already-aborted signal to fetch when the caller's signal was aborted, and rejects with AudioProviderCallError", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const caller = new AbortController();
    caller.abort();

    const rejection = createDeepInfraWhisperProvider("test-key").transcribe({
      audio: new Uint8Array(),
      filename: "chunk.opus",
      mimeType: "audio/ogg",
      signal: caller.signal,
    });

    await expect(rejection).rejects.toBeInstanceOf(AudioProviderCallError);
    await expect(rejection).rejects.toThrow("AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  });
});
