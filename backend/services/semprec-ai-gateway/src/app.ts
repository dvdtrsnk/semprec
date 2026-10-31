import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Pool } from "pg";
import { createCompleteRequestListener, type CompleteHandlerOptions } from "./completeHandler.js";
import { createAudioRequestListener, type AudioHandlerOptions } from "./audioHandler.js";
import { createAudioConcurrencyLimit, MAX_CONCURRENT_AUDIO_REQUESTS } from "./audioConcurrencyLimit.js";
import { createTtsStreamRequestListener, TTS_STREAM_PATH, type TtsStreamHandlerOptions } from "./ttsStreamHandler.js";
import { STT_STREAM_PATH, type SttStreamUpgradeHandler } from "./sttStreamHandler.js";
import { createPiMessagesRequestListener, type PiMessagesHandlerOptions } from "./piMessagesHandler.js";

/**
 * Every path the gateway serves. Every endpoint must be an entry of this table, so a suite can
 * enumerate the endpoints and a new one cannot be added without it.
 */
export const GATEWAY_ENDPOINTS = [
  "/internal/complete",
  "/internal/pi/messages",
  "/internal/diarize",
  "/internal/transcribe",
  STT_STREAM_PATH,
  TTS_STREAM_PATH,
] as const;

export type GatewayEndpoint = (typeof GATEWAY_ENDPOINTS)[number];

function isGatewayEndpoint(pathname: string): pathname is GatewayEndpoint {
  return (GATEWAY_ENDPOINTS as readonly string[]).includes(pathname);
}

/**
 * The full request dispatcher for `semprec-ai-gateway`, mirroring `semprec-api`'s `app.ts`
 * pattern: `serve.ts` calls this to get the listener it hands to `http.createServer`, and tests
 * call it the same way to drive a real in-memory server with no process/port of its own to
 * manage. Requests are routed by looking the pathname up in a table keyed by
 * {@link GATEWAY_ENDPOINTS}; every endpoint must be an entry of that table.
 */
export function createDispatcher(
  pool: Pool,
  options: CompleteHandlerOptions,
  audioOptions: AudioHandlerOptions,
  piOptions: PiMessagesHandlerOptions,
  ttsOptions?: TtsStreamHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const completeListener = createCompleteRequestListener(pool, options);
  const audioListener = createAudioRequestListener(pool, audioOptions);
  const piMessagesListener = createPiMessagesRequestListener(pool, piOptions);
  // Suites that never reach the synthesis route omit its options; the route then answers 404.
  const ttsListener = ttsOptions === undefined ? undefined : createTtsStreamRequestListener(pool, ttsOptions);
  const audioLimit = createAudioConcurrencyLimit(MAX_CONCURRENT_AUDIO_REQUESTS);

  function handleAudio(req: IncomingMessage, res: ServerResponse): void {
    const release = audioLimit.tryAcquire();
    if (release === null) {
      // Refused before the body is read, so a rejected request never adds to the memory the
      // limit exists to bound; the caller's job retry picks it up after `Retry-After`.
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Retry-After": "1" });
      res.end(JSON.stringify({ error: "Audio capacity exhausted", code: "audio_capacity_exhausted" }));
      return;
    }
    // `close` fires both after the response finishes and when the connection drops first, so
    // the slot is freed on every path out of the handler.
    res.on("close", release);
    void audioListener(req, res);
  }

  const handlers: Record<GatewayEndpoint, (req: IncomingMessage, res: ServerResponse) => void> = {
    "/internal/complete": (req, res) => void completeListener(req, res),
    "/internal/pi/messages": (req, res) => void piMessagesListener(req, res),
    "/internal/diarize": handleAudio,
    "/internal/transcribe": handleAudio,
    [TTS_STREAM_PATH]: (req, res) => {
      if (ttsListener === undefined) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      ttsListener(req, res);
    },
    // A WebSocket route: it is served by `createUpgradeDispatcher`, so a plain request is refused.
    [STT_STREAM_PATH]: (_req, res) => {
      res.writeHead(426, { "Content-Type": "application/json; charset=utf-8", Upgrade: "websocket" });
      res.end(JSON.stringify({ error: "Upgrade required", code: "upgrade_required" }));
    },
  };

  return function dispatch(req: IncomingMessage, res: ServerResponse): void {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (isGatewayEndpoint(pathname)) {
      handlers[pathname](req, res);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not found" }));
  };
}

/**
 * The `upgrade` listener `serve.ts` hands to the HTTP server: `/internal/stt/stream` goes to the
 * streaming speech-to-text handler, any other path is refused and its socket closed.
 */
export function createUpgradeDispatcher(
  stt: SttStreamUpgradeHandler,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return function dispatchUpgrade(req, socket, head): void {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === STT_STREAM_PATH) {
      stt.handleUpgrade(req, socket, head);
      return;
    }
    socket.on("error", () => undefined);
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  };
}
