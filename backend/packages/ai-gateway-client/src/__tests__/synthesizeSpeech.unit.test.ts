import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AiGatewayFailedError, runInTenant } from "@semprec/shared";
import { synthesizeSpeech } from "../httpAiGatewayClient.js";

const TENANT_ID = "6f1e2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";

let server: Server | undefined;
let seen: { headers: IncomingMessage["headers"]; body: string } | undefined;

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen = { headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return address.port;
}

async function collect(audio: AsyncIterable<Uint8Array>): Promise<number> {
  let bytes = 0;
  for await (const chunk of audio) bytes += chunk.byteLength;
  return bytes;
}

afterEach(async () => {
  seen = undefined;
  const current = server;
  server = undefined;
  if (!current) return;
  current.closeAllConnections();
  await new Promise<void>((resolve) => current.close(() => resolve()));
});

describe("synthesizeSpeech", () => {
  it("posts the text and voice with the token and tenant, and yields the audio chunks", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "audio/L16; rate=24000; channels=1" });
      res.write(Buffer.alloc(100));
      res.end(Buffer.alloc(50));
    });

    const audio = await runInTenant(TENANT_ID, () =>
      synthesizeSpeech({ port, token: "secret" }, { text: "Hello.", voice: "nova" }),
    );

    expect(await collect(audio)).toBe(150);
    expect(JSON.parse(seen?.body ?? "")).toEqual({ text: "Hello.", voice: "nova" });
    expect(seen?.headers.authorization).toBe("Bearer secret");
    expect(seen?.headers["x-semprec-tenant-id"]).toBe(TENANT_ID);
  });

  it("rejects with budget_exceeded for the gateway's budget refusal", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "AI budget exceeded", code: "budget_exceeded" }));
    });

    await expect(synthesizeSpeech({ port, token: "t" }, { text: "Hello.", voice: "nova" })).rejects.toMatchObject({
      name: "AiGatewayFailedError",
      reason: "budget_exceeded",
    });
  });

  it("rejects with http for any other non-2xx answer", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(503);
      res.end();
    });

    const error = await synthesizeSpeech({ port, token: "t" }, { text: "Hello.", voice: "nova" }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(AiGatewayFailedError);
    expect((error as AiGatewayFailedError).reason).toBe("http");
  });

  it("cancels the request when the reader stops early", async () => {
    let closedEarly = false;
    const port = await serve((_req, res) => {
      res.writeHead(200);
      res.write(Buffer.alloc(10));
      res.on("close", () => {
        closedEarly = !res.writableFinished;
      });
    });
    const audio = await synthesizeSpeech({ port, token: "t" }, { text: "Hello.", voice: "nova" });

    for await (const chunk of audio) {
      expect(chunk.byteLength).toBe(10);
      break;
    }

    await expect.poll(() => closedEarly).toBe(true);
  });

  it("aborts the request when the caller's signal aborts", async () => {
    const port = await serve(() => undefined);
    const abort = new AbortController();
    const pending = synthesizeSpeech({ port, token: "t" }, { text: "Hello.", voice: "nova", signal: abort.signal });

    abort.abort();

    await expect(pending).rejects.toMatchObject({ reason: "http" });
  });
});
