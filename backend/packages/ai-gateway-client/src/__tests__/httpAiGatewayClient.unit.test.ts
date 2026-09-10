import { afterEach, describe, expect, it, vi } from "vitest";
import { AiGatewayFailedError } from "@semprec/shared";
import { createHttpAiGatewayClient } from "../httpAiGatewayClient.js";

const INPUT = {
  projectItemId: "11111111-1111-1111-1111-111111111111",
  operation: "agent_guidance_drift",
  temperature: 0,
  system: "you are helpful",
  messages: [{ role: "user" as const, content: "hello" }],
  responseSchema: { type: "object" },
};

describe("createHttpAiGatewayClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the gateway's /internal/complete with a bearer token and returns content/usage", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:4100/internal/complete");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
      expect(JSON.parse(init.body as string)).toEqual(INPUT);
      return new Response(JSON.stringify({ content: { ok: true }, usage: { inputTokens: 10, outputTokens: 5 } }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpAiGatewayClient({ port: 4100, token: "secret-token" });
    const result = await client.complete(INPUT);

    expect(result).toEqual({ content: { ok: true }, usage: { inputTokens: 10, outputTokens: 5 } });
  });

  it("maps a network/timeout failure to ai_gateway_failed with reason 'timeout'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted", "TimeoutError");
      }),
    );

    const client = createHttpAiGatewayClient({ port: 4100, token: "secret-token" });
    const error = await client.complete(INPUT).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AiGatewayFailedError);
    expect((error as InstanceType<typeof AiGatewayFailedError>).reason).toBe("timeout");
  });

  it("maps a non-2xx response to ai_gateway_failed with reason 'http', leaking no response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ secret: "provider api key leaked here" }), { status: 500 })),
    );

    const client = createHttpAiGatewayClient({ port: 4100, token: "secret-token" });
    const error = await client.complete(INPUT).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AiGatewayFailedError);
    expect((error as InstanceType<typeof AiGatewayFailedError>).reason).toBe("http");
    expect(JSON.stringify(error)).not.toContain("secret");
  });

  it("maps an invalid JSON body to ai_gateway_failed with reason 'invalid_response'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );

    const client = createHttpAiGatewayClient({ port: 4100, token: "secret-token" });
    const error = await client.complete(INPUT).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AiGatewayFailedError);
    expect((error as InstanceType<typeof AiGatewayFailedError>).reason).toBe("invalid_response");
  });

  it("maps a response missing usage fields to ai_gateway_failed with reason 'invalid_response'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ content: {} }), { status: 200 })),
    );

    const client = createHttpAiGatewayClient({ port: 4100, token: "secret-token" });
    const error = await client.complete(INPUT).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AiGatewayFailedError);
    expect((error as InstanceType<typeof AiGatewayFailedError>).reason).toBe("invalid_response");
  });

  it("maps a response body over the size cap to ai_gateway_failed with reason 'invalid_response' without buffering it whole", async () => {
    const hugeBody = JSON.stringify({
      content: "x".repeat(2 * 1024 * 1024),
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(hugeBody, { status: 200 })),
    );

    const client = createHttpAiGatewayClient({ port: 4100, token: "secret-token" });
    const error = await client.complete(INPUT).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AiGatewayFailedError);
    expect((error as InstanceType<typeof AiGatewayFailedError>).reason).toBe("invalid_response");
  });
});
