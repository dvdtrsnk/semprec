import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type WebSocket as ServerSocket } from "ws";
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
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
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

    expect(stream.sendAudio(new Uint8Array([1, 2]))).toBe(true);
    stream.end();
    server.send(JSON.stringify({ type: "partial", text: "ahoj" }));
    server.send(JSON.stringify({ type: "final", text: "ahoj svete" }));
    server.send(JSON.stringify({ type: "error", code: "budget_exceeded" }));
    server.close(1008);
    await rec.closed;
    expect(stream.sendAudio(new Uint8Array([3, 4]))).toBe(false);

    expect(received).toEqual([
      { data: "0102", binary: true },
      { data: Buffer.from('{"type":"end"}').toString("hex"), binary: false },
    ]);
    expect(rec.log).toEqual(["partial:ahoj", "final:ahoj svete", "error:budget_exceeded", "close"]);
  });

  it("sends an attribute control message while open and reports false once the stream is closed", async () => {
    const harness = await startServer();
    const rec = recorder();
    const stream = await openSttStream({ port: harness.port, token: "secret" }, {}, rec.events);
    const server = await harness.connected;
    const received: Array<{ data: string; binary: boolean }> = [];
    server.on("message", (data, binary) => received.push({ data: (data as Buffer).toString("utf8"), binary }));
    const messageId = "8b1e2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";

    expect(stream.attribute(messageId)).toBe(true);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received).toEqual([
      { data: JSON.stringify({ type: "attribute", sempMessageId: messageId }), binary: false },
    ]);

    server.close(1008);
    await rec.closed;
    expect(stream.attribute(messageId)).toBe(false);
    expect(received).toHaveLength(1);
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

  it("admits a real loopback send at the buffer bound and refuses overflow before sending", async () => {
    const harness = await startServer();
    const rec = recorder();
    const stream = await openSttStream({ port: harness.port, token: "secret" }, {}, rec.events);
    const server = await harness.connected;
    const received: Buffer[] = [];
    server.on("message", (data) => {
      if (Buffer.isBuffer(data)) received.push(Buffer.from(data));
      else if (Array.isArray(data)) received.push(Buffer.concat(data));
      else received.push(Buffer.from(data));
    });
    // Synthetic transport buffer readings exercise the admission edge on the real socket.
    const buffered = vi.spyOn(WebSocket.prototype, "bufferedAmount", "get");
    try {
      buffered.mockReturnValue(262141);
      expect(stream.sendAudio(new Uint8Array([1, 2]))).toBe(true);
      buffered.mockReturnValue(262142);
      expect(stream.sendAudio(new Uint8Array([3, 4]))).toBe(true);
      buffered.mockReturnValue(262143);
      expect(stream.sendAudio(new Uint8Array([5, 6]))).toBe(false);
    } finally {
      buffered.mockRestore();
    }
    await vi.waitFor(() => expect(received).toEqual([Buffer.from([1, 2]), Buffer.from([3, 4])]));
    stream.close();
    await rec.closed;
    expect(stream.sendAudio(new Uint8Array([7, 8]))).toBe(false);
    expect(received).toHaveLength(2);
  });

  it("rejects with an http failure when the gateway refuses the upgrade", async () => {
    const harness = await startServer();
    await Promise.all(servers.splice(0).map((wss) => new Promise((resolve) => wss.close(resolve))));

    await expect(openSttStream({ port: harness.port, token: "secret" }, {}, recorder().events)).rejects.toEqual(
      new AiGatewayFailedError("http"),
    );
  });
});
