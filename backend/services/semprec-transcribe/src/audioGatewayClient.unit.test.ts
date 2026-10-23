import { afterEach, describe, expect, it, vi } from "vitest";
import { runAsSystem, runInTenant } from "@semprec/shared";
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

  describe("x-semprec-tenant-id", () => {
    const TENANT_ID = "6f1c0a52-9d1e-4b7e-8c53-2f0e5c1a7b11";

    async function sentHeaders(
      run: (call: () => Promise<unknown>) => Promise<unknown>,
      method: "diarize" | "transcribe",
    ): Promise<Record<string, string>> {
      const body = method === "diarize" ? { turns: [] } : { text: "hi", language: null, segments: [] };
      const fetchMock = vi.fn(
        async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const client = createHttpAudioGatewayClient({ port: 4100, token: "secret-token" });
      await run(() => client[method](REQUEST));
      return fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    }

    it.each(["diarize", "transcribe"] as const)("%s carries the ambient tenant scope", async (method) => {
      const headers = await sentHeaders((call) => runInTenant(TENANT_ID, call), method);
      expect(headers["x-semprec-tenant-id"]).toBe(TENANT_ID);
    });

    it.each(["diarize", "transcribe"] as const)("%s sends no header outside any scope", async (method) => {
      const headers = await sentHeaders((call) => call(), method);
      expect(headers).not.toHaveProperty("x-semprec-tenant-id");
    });

    it.each(["diarize", "transcribe"] as const)("%s sends no header in system scope", async (method) => {
      const headers = await sentHeaders((call) => runAsSystem("unit test: system scope has no tenant", call), method);
      expect(headers).not.toHaveProperty("x-semprec-tenant-id");
    });
  });
});
