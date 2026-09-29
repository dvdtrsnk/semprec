import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderCallError } from "../types.js";
import { createAnthropicStructuredProvider } from "../anthropicProvider.js";

const REQUEST = {
  model: "claude-sonnet-5",
  temperature: 0,
  system: "you are helpful",
  messages: [{ role: "user" as const, content: "hello" }],
  responseSchema: { type: "object" },
};

const SUCCESS_BODY = JSON.stringify({
  content: [{ type: "tool_use", input: { ok: true } }],
  usage: { input_tokens: 1, output_tokens: 1 },
});

function successResponse(): Response {
  return new Response(SUCCESS_BODY, { status: 200 });
}

function errorResponse(
  status: number,
  options?: { headers?: Record<string, string>; onCancel?: () => void },
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "error" })));
      controller.close();
    },
    cancel() {
      options?.onCancel?.();
    },
  });
  return new Response(stream, { status, headers: options?.headers });
}

describe("createAnthropicStructuredProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("throws ProviderCallError, not a TypeError, when the 200 response body has no content array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ type: "error" }), { status: 200 })),
    );

    const provider = createAnthropicStructuredProvider("test-api-key");

    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(ProviderCallError);
  });

  it("throws ProviderCallError when the response body exceeds the size cap", async () => {
    const hugeBody = JSON.stringify({ content: [{ type: "tool_use", input: "x".repeat(11 * 1024 * 1024) }] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(hugeBody, { status: 200 })),
    );

    const provider = createAnthropicStructuredProvider("test-api-key");

    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(ProviderCallError);
  });

  it("returns the tool_use input and usage on a well-formed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              content: [{ type: "tool_use", input: { contradictions: ["one"] } }],
              usage: { input_tokens: 12, output_tokens: 3 },
            }),
            { status: 200 },
          ),
      ),
    );

    const provider = createAnthropicStructuredProvider("test-api-key");
    const result = await provider.complete(REQUEST);

    expect(result).toEqual({ content: { contradictions: ["one"] }, inputTokens: 12, outputTokens: 3 });
  });

  it("throws ProviderCallError naming the schema path, not a TypeError, when a content block is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              content: [null, { type: "tool_use", input: {} }],
              usage: { input_tokens: 12, output_tokens: 3 },
            }),
            { status: 200 },
          ),
      ),
    );

    const provider = createAnthropicStructuredProvider("test-api-key");
    const rejection = provider.complete(REQUEST);

    await expect(rejection).rejects.toBeInstanceOf(ProviderCallError);
    await expect(rejection).rejects.toThrow("content.0");
  });

  it("throws ProviderCallError naming usage when the response carries no usage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ content: [{ type: "tool_use", input: { contradictions: [] } }] }), {
            status: 200,
          }),
      ),
    );

    const provider = createAnthropicStructuredProvider("test-api-key");
    const rejection = provider.complete(REQUEST);

    await expect(rejection).rejects.toBeInstanceOf(ProviderCallError);
    await expect(rejection).rejects.toThrow("usage");
  });

  it("throws ProviderCallError when a usage token count is not a number", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              content: [{ type: "tool_use", input: {} }],
              usage: { input_tokens: "12", output_tokens: 3 },
            }),
            { status: 200 },
          ),
      ),
    );

    const provider = createAnthropicStructuredProvider("test-api-key");
    const rejection = provider.complete(REQUEST);

    await expect(rejection).rejects.toBeInstanceOf(ProviderCallError);
    await expect(rejection).rejects.toThrow("usage.input_tokens");
  });

  it("throws ProviderCallError when the tool_use block carries no input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              content: [{ type: "tool_use" }],
              usage: { input_tokens: 12, output_tokens: 3 },
            }),
            { status: 200 },
          ),
      ),
    );

    const provider = createAnthropicStructuredProvider("test-api-key");
    const rejection = provider.complete(REQUEST);

    await expect(rejection).rejects.toBeInstanceOf(ProviderCallError);
    await expect(rejection).rejects.toThrow("Anthropic tool_use block carried no input");
  });

  it("cancels the response body before throwing ProviderCallError on a non-retryable non-2xx status", async () => {
    let bodyCancelled = false;
    const errorBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ type: "error", error: { type: "permission_error" } })),
        );
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(errorBody, { status: 403 })),
    );

    const provider = createAnthropicStructuredProvider("test-api-key");
    const rejection = provider.complete(REQUEST);

    await expect(rejection).rejects.toBeInstanceOf(ProviderCallError);
    await expect(rejection).rejects.toThrow("HTTP 403");
    expect(bodyCancelled).toBe(true);
  });

  it("passes an already-aborted signal to fetch when the caller's signal was aborted, and rejects with ProviderCallError", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const caller = new AbortController();
    caller.abort();

    const rejection = createAnthropicStructuredProvider("test-api-key").complete({ ...REQUEST, signal: caller.signal });

    await expect(rejection).rejects.toBeInstanceOf(ProviderCallError);
    await expect(rejection).rejects.toThrow("AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1].signal?.aborted).toBe(true);
  });

  describe("retries", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // A whole-second epoch so an HTTP-date `retry-after` (second resolution) round-trips exactly.
      vi.setSystemTime(0);
      vi.spyOn(Math, "random").mockReturnValue(0.5);
    });

    it("retries a 529 once and resolves with the second response, only after the jittered delay elapsed", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(errorResponse(529)).mockResolvedValueOnce(successResponse());
      vi.stubGlobal("fetch", fetchMock);

      const resultPromise = createAnthropicStructuredProvider("test-api-key").complete(REQUEST);

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // delay = fullJitter(500 * 2**0) = 0.5 * 500 = 250ms
      await vi.advanceTimersByTimeAsync(249);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const result = await resultPromise;
      expect(result).toEqual({ content: { ok: true }, inputTokens: 1, outputTokens: 1 });
    });

    it("honours a retry-after header in seconds as the minimum wait before the next attempt", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(errorResponse(429, { headers: { "retry-after": "2" } }))
        .mockResolvedValueOnce(successResponse());
      vi.stubGlobal("fetch", fetchMock);

      const resultPromise = createAnthropicStructuredProvider("test-api-key").complete(REQUEST);

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await expect(resultPromise).resolves.toEqual({ content: { ok: true }, inputTokens: 1, outputTokens: 1 });
    });

    it("honours a retry-after header as an HTTP-date as the minimum wait before the next attempt", async () => {
      const now = Date.now();
      const retryAfterDate = new Date(now + 3000).toUTCString();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(errorResponse(429, { headers: { "retry-after": retryAfterDate } }))
        .mockResolvedValueOnce(successResponse());
      vi.stubGlobal("fetch", fetchMock);

      const resultPromise = createAnthropicStructuredProvider("test-api-key").complete(REQUEST);

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2900);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await expect(resultPromise).resolves.toEqual({ content: { ok: true }, inputTokens: 1, outputTokens: 1 });
    });

    it("rejects with ProviderCallError after 3 attempts on repeated 500s, cancelling every non-2xx body", async () => {
      const cancelled: boolean[] = [false, false, false];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(errorResponse(500, { onCancel: () => (cancelled[0] = true) }))
        .mockResolvedValueOnce(errorResponse(500, { onCancel: () => (cancelled[1] = true) }))
        .mockResolvedValueOnce(errorResponse(500, { onCancel: () => (cancelled[2] = true) }));
      vi.stubGlobal("fetch", fetchMock);

      const rejection = createAnthropicStructuredProvider("test-api-key").complete(REQUEST);
      const assertion = expect(rejection).rejects.toThrow(/after 3 attempts$/);

      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      await expect(rejection).rejects.toBeInstanceOf(ProviderCallError);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(cancelled).toEqual([true, true, true]);
    });

    it("rejects after a single fetch on a non-retryable status", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(errorResponse(400));
      vi.stubGlobal("fetch", fetchMock);

      const rejection = createAnthropicStructuredProvider("test-api-key").complete(REQUEST);
      const assertion = expect(rejection).rejects.toThrow("HTTP 400");

      await vi.advanceTimersByTimeAsync(0);
      await assertion;
      await expect(rejection).rejects.toBeInstanceOf(ProviderCallError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("rejects with ProviderCallError, without a second fetch, when the caller's signal aborts during the backoff", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(errorResponse(529)).mockResolvedValueOnce(successResponse());
      vi.stubGlobal("fetch", fetchMock);
      const caller = new AbortController();

      const rejection = createAnthropicStructuredProvider("test-api-key").complete({
        ...REQUEST,
        signal: caller.signal,
      });
      const assertion = expect(rejection).rejects.toBeInstanceOf(ProviderCallError);

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      caller.abort();
      await vi.advanceTimersByTimeAsync(250);

      await assertion;
      await expect(rejection).rejects.toThrow("AbortError");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("passes the same signal object to every attempt's fetch", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(errorResponse(529)).mockResolvedValueOnce(successResponse());
      vi.stubGlobal("fetch", fetchMock);

      const resultPromise = createAnthropicStructuredProvider("test-api-key").complete(REQUEST);
      await vi.advanceTimersByTimeAsync(250);
      await resultPromise;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const firstSignal = fetchMock.mock.calls[0]?.[1].signal;
      const secondSignal = fetchMock.mock.calls[1]?.[1].signal;
      expect(firstSignal).toBe(secondSignal);
    });
  });
});
