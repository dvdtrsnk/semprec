import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AudioGatewayBudgetExceededError,
  AudioGatewayCallError,
  createHttpAudioGatewayClient,
} from "./audioGatewayClient.js";

const REQUEST = { audio: new Uint8Array([1, 2, 3]), filename: "chunk-0.opus", mimeType: "audio/ogg", audioSeconds: 1 };

function stubResponse(body: string, status: number): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status })),
  );
}

describe("createHttpAudioGatewayClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws AudioGatewayBudgetExceededError on the gateway's 403 budget rejection", async () => {
    stubResponse(JSON.stringify({ error: "Daily cap reached", code: "budget_exceeded" }), 403);
    const client = createHttpAudioGatewayClient({ port: 4100, token: "secret-token" });

    await expect(client.transcribe(REQUEST)).rejects.toBeInstanceOf(AudioGatewayBudgetExceededError);
    await expect(client.diarize(REQUEST)).rejects.toBeInstanceOf(AudioGatewayBudgetExceededError);
  });

  it("throws a plain AudioGatewayCallError for any other 403 or non-2xx response", async () => {
    for (const [body, status] of [
      [JSON.stringify({ code: "forbidden" }), 403],
      ["not json", 403],
      [JSON.stringify({ code: "budget_exceeded" }), 502],
    ] as const) {
      stubResponse(body, status);
      const client = createHttpAudioGatewayClient({ port: 4100, token: "secret-token" });

      const error = await client.transcribe(REQUEST).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(AudioGatewayCallError);
      expect(error).not.toBeInstanceOf(AudioGatewayBudgetExceededError);
      expect((error as Error).message).toBe(`Gateway responded with HTTP ${status}`);
    }
  });
});
