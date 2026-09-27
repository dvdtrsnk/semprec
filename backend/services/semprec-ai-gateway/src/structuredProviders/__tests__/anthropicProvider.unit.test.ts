import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderCallError } from "../types.js";
import { createAnthropicStructuredProvider } from "../anthropicProvider.js";

const REQUEST = {
  model: "claude-sonnet-5",
  temperature: 0,
  system: "you are helpful",
  messages: [{ role: "user" as const, content: "hello" }],
  responseSchema: { type: "object" },
};

describe("createAnthropicStructuredProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("cancels the response body before throwing ProviderCallError on a non-2xx status", async () => {
    let bodyCancelled = false;
    const errorBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ type: "error", error: { type: "overloaded_error" } })),
        );
      },
      cancel() {
        bodyCancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(errorBody, { status: 529 })),
    );

    const provider = createAnthropicStructuredProvider("test-api-key");
    const rejection = provider.complete(REQUEST);

    await expect(rejection).rejects.toBeInstanceOf(ProviderCallError);
    await expect(rejection).rejects.toThrow("HTTP 529");
    expect(bodyCancelled).toBe(true);
  });
});
