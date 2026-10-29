import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { AiGatewayFailedError, runInTenant } from "@semprec/shared";
import { openSttStream, type SttStreamErrorCode } from "../httpAiGatewayClient.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

interface Harness {
  port: number;
  requests: IncomingMessage[];
  sockets: ServerSocket[];
  connected: Promise<ServerSocket>;
}

const servers: WebSocketServer[] = [];

async function startServer(): Promise<Harness> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const requests: IncomingMessage[] = [];
  const sockets: ServerSocket[] = [];
  const connected = new Promise<ServerSocket>((resolve) =>
    wss.on("connection", (socket, req) => {
      requests.push(req);
      sockets.push(socket);
      resolve(socket);
    }),
  );
  const address = wss.address();
  if (typeof address === "string") throw new Error("expected a TCP address");
  return { port: address.port, requests, sockets, connected };
}

function recorder() {
  const log: string[] = [];
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  return {
    log,
    closed,
    events: {
      onPartial: (text: string) => log.push(`partial:${text}`),
      onFinal: (text: string) => log.push(`final:${text}`),
      onError: (code: SttStreamErrorCode) => log.push(`error:${code}`),
      onClose: () => {
        log.push("close");
        resolveClosed();
      },
    },
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((wss) => {
      for (const client of wss.clients) client.terminate();
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    }),
  );
});

describe("openSttStream", () => {
  it("connects with the bearer token, the ambient tenant and the language, and relays messages both ways", async () => {
    const harness = await startServer();
    const rec = recorder();

    const stream = await runInTenant(TENANT, () =>
      openSttStream({ port: harness.port, token: "secret" }, { language: "cs" }, rec.events),
    );
    const server = await harness.connected;
    const received: Array<{ data: string; binary: boolean }> = [];
    server.on("message", (data, binary) => received.push({ data: (data as Buffer).toString("hex"), binary }));

    expect(harness.requests[0]?.url).toBe("/internal/stt/stream?language=cs");
    expect(harness.requests[0]?.headers.authorization).toBe("Bearer secret");
    expect(harness.requests[0]?.headers["x-semprec-tenant-id"]).toBe(TENANT);

    stream.sendAudio(new Uint8Array([1, 2]));
    stream.end();
    server.send(JSON.stringify({ type: "partial", text: "ahoj" }));
    server.send(JSON.stringify({ type: "final", text: "ahoj svete" }));
    server.send(JSON.stringify({ type: "error", code: "budget_exceeded" }));
    server.close(1008);
    await rec.closed;

    expect(received).toEqual([
      { data: "0102", binary: true },
      { data: Buffer.from('{"type":"end"}').toString("hex"), binary: false },
    ]);
    expect(rec.log).toEqual(["partial:ahoj", "final:ahoj svete", "error:budget_exceeded", "close"]);
  });

  it("reports a gateway message it cannot parse as provider_error and closes the stream", async () => {
    const harness = await startServer();
    const rec = recorder();
    await openSttStream({ port: harness.port, token: "secret" }, {}, rec.events);
    const server = await harness.connected;

    server.send(JSON.stringify({ type: "error", code: "something_else" }));
    await rec.closed;

    expect(rec.log).toEqual(["error:provider_error", "close"]);
  });

  it("closes the connection when the caller aborts", async () => {
    const harness = await startServer();
    const rec = recorder();
    const abort = new AbortController();
    await openSttStream({ port: harness.port, token: "secret" }, { signal: abort.signal }, rec.events);
    await harness.connected;

    abort.abort();
    await rec.closed;

    expect(rec.log).toEqual(["close"]);
  });

  it("rejects with an http failure when the gateway refuses the upgrade", async () => {
    const harness = await startServer();
    await Promise.all(servers.splice(0).map((wss) => new Promise((resolve) => wss.close(resolve))));

    await expect(openSttStream({ port: harness.port, token: "secret" }, {}, recorder().events)).rejects.toEqual(
      new AiGatewayFailedError("http"),
    );
  });
});
