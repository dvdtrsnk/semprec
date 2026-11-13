import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Pool } from "pg";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { z } from "zod";
import { ChokePointError, ValidationError } from "@semprec/data";
import {
  attributeAudioStreamChunks,
  BudgetExceededError,
  reserveAudioStreamChunk,
  type AudioStreamChunk,
  type GlobalAiCaps,
} from "@semprec/ai-gateway";
import {
  STREAM_AUDIO_BYTES_PER_SECOND,
  type StreamingTranscriptionProvider,
  type StreamingTranscriptionSession,
} from "./audioProviders/types.js";
import { createAudioConcurrencyLimit } from "./audioConcurrencyLimit.js";
import { extractBearerToken, tokensMatch } from "./audioHandler.js";
import { readCallerTenantId, runForCallerTenant } from "./callerTenant.js";
import { logger } from "./logger.js";

export const STT_STREAM_PATH = "/internal/stt/stream";

/** The `ai_gateway_calls.operation` of every chunk row of this route. */
export const STT_STREAM_OPERATION = "voice_transcribe_stream";

/**
 * Limits of docs/adr/2026-10-28-live-voice-chains-speech-to-text-agent-turn-and-text-to-speech.md.
 * A binary frame over the cap is refused by the socket library itself (close 1009), before the
 * frame is buffered whole.
 */
const MAX_BINARY_FRAME_BYTES = 16 * 1024;
const MAX_TEXT_FRAME_BYTES = 4 * 1024;
const MAX_SESSION_MS = 30 * 60 * 1000;
const IDLE_TIMEOUT_MS = 60 * 1000;
/** Bytes received but not yet processed (waiting on a reservation or the provider); beyond it the stream is closed. */
const MAX_PENDING_BYTES = 256 * 1024;
/** A paused reader may not turn into unbounded server memory: past this the stream is closed (1013). */
const MAX_BUFFERED_OUTGOING_BYTES = 256 * 1024;
/** A client that ignores the close handshake is dropped after this long. */
const CLOSE_GRACE_MS = 5_000;
/** How many streams may run at once; each one holds a provider connection and a reserved chunk. */
export const MAX_CONCURRENT_STT_STREAMS = 8;
/** The ADR's chunk length; one `ai_gateway_calls` row covers this many seconds of audio. */
export const DEFAULT_STT_CHUNK_SECONDS = 30;

const LANGUAGE_PATTERN = /^[a-z]{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The JSON control messages a caller may send; anything else, or a malformed one, closes the stream as `invalid_frame`. */
const controlMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("end") }),
  z.object({ type: z.literal("attribute"), sempMessageId: z.string().regex(UUID_PATTERN) }),
]);

export type SttStreamErrorCode =
  "budget_exceeded" | "provider_error" | "capacity" | "session_limit" | "idle_timeout" | "invalid_frame";

export interface SttStreamHandlerOptions {
  internalToken: string;
  provider: StreamingTranscriptionProvider;
  /** Price of one audio hour; a chunk is reserved at the price of a full chunk and settled at the seconds used. */
  pricePerAudioHour: number;
  chunkSeconds: number;
  maxConcurrentStreams: number;
  globalCaps: GlobalAiCaps;
}

export interface SttStreamUpgradeHandler {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Ends every open stream and resolves once their chunk rows are settled or failed. */
  closeAll(): Promise<void>;
}

function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function readLanguage(url: URL): string | undefined {
  const values = url.searchParams.getAll("language");
  if (values.length === 0) return undefined;
  const [language] = values;
  if (values.length > 1 || language === undefined || !LANGUAGE_PATTERN.test(language)) {
    throw new ValidationError("'language' must be a two-letter ISO 639-1 code", { field: "language" });
  }
  return language;
}

/**
 * Handles the WebSocket upgrade of `/internal/stt/stream` (#1396): bearer token and tenant as on
 * the other internal routes, a dedicated concurrency limit, and one stream per accepted socket.
 *
 * Inbound frames: raw 16 kHz PCM s16le in binary frames, one JSON `{type: "end"}` and any number of
 * JSON `{type: "attribute", sempMessageId}` (#2020): it sets `semp_message_id` on every chunk row this stream
 * reserved since it opened or since its previous `attribute` message, in the stream's tenant, and on no other row.
 * Rows that no later `attribute` message reaches stay unattributed. Outbound
 * JSON: `{type: "partial"|"final", text}` and `{type: "error", code}`. Budget is reserved in
 * chunks of `chunkSeconds` (one `ai_gateway_calls` row each), before the chunk's audio is
 * forwarded. Audio exists only in the frame being forwarded; it is never stored or logged, and
 * neither are transcripts.
 */
export function createSttStreamUpgradeHandler(pool: Pool, options: SttStreamHandlerOptions): SttStreamUpgradeHandler {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BINARY_FRAME_BYTES });
  const limit = createAudioConcurrencyLimit(options.maxConcurrentStreams);
  const open = new Set<{ drop(): Promise<void> }>();
  const chunkCostUsd = (options.chunkSeconds / 3600) * options.pricePerAudioHour;
  const chunkCapacityBytes = Math.floor((options.chunkSeconds * STREAM_AUDIO_BYTES_PER_SECOND) / 2) * 2;
  if (!Number.isSafeInteger(chunkCapacityBytes) || chunkCapacityBytes < 2) {
    throw new Error("Speech-to-text chunk duration must accommodate at least one PCM sample");
  }
  let closing = false;

  function runStream(ws: WebSocket, tenantId: string, language: string | undefined): void {
    // Registered first: an unhandled `error` event on any path out of this function would crash the process.
    ws.on("error", (err) => {
      logger.warn({ err: { name: err.name } }, "Speech-to-text stream socket error");
    });
    const releaseSlot = limit.tryAcquire();
    if (releaseSlot === null) {
      // Refused before any chunk is reserved or provider session is opened.
      ws.send(JSON.stringify({ type: "error", code: "capacity" satisfies SttStreamErrorCode }), () => ws.close(1013));
      setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
      return;
    }

    const release = releaseSlot;
    const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runForCallerTenant(tenantId, fn);
    const providerAbort = new AbortController();
    let session: StreamingTranscriptionSession | null = null;
    let chunk: AudioStreamChunk | null = null;
    let chunkBytesUsed = 0;
    /** The chunks reserved since the stream opened or since the last `attribute` message. */
    let unattributed: AudioStreamChunk[] = [];
    let ended = false;
    let done = false;
    let pendingBytes = 0;
    let queue: Promise<void> = Promise.resolve();
    let cleanup: Promise<void> | null = null;
    let idleTimer: NodeJS.Timeout | undefined;

    const handle = {
      drop: () => {
        finish(null);
        return cleanup ?? Promise.resolve();
      },
    };
    open.add(handle);

    /** Settles the open chunk with the real seconds when audio was forwarded, else fails it. */
    async function closeChunk(): Promise<void> {
      const current = chunk;
      chunk = null;
      if (current === null) return;
      const seconds = chunkBytesUsed / STREAM_AUDIO_BYTES_PER_SECOND;
      chunkBytesUsed = 0;
      if (seconds > 0) {
        await inTenant(() => current.settle(seconds, (seconds / 3600) * options.pricePerAudioHour));
      } else {
        await inTenant(() => current.fail());
      }
    }

    /**
     * The single exit: stops timers and the provider session, accounts for the open chunk and frees
     * the stream slot. `closeCode` null means the socket is already gone or being dropped.
     */
    function finish(closeCode: number | null, errorCode?: SttStreamErrorCode): void {
      if (done) return;
      done = true;
      clearTimeout(sessionTimer);
      clearTimeout(idleTimer);
      providerAbort.abort();
      session?.abort();
      if (ws.readyState === WebSocket.OPEN) {
        if (errorCode !== undefined) ws.send(JSON.stringify({ type: "error", code: errorCode }));
        if (closeCode === null) ws.terminate();
        else {
          ws.close(closeCode);
          setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
        }
      }
      cleanup = queue
        .then(() => closeChunk())
        .catch((err: unknown) => {
          logger.error(
            { err: { name: err instanceof Error ? err.name : "unknown" } },
            "Failed to account for the open speech-to-text stream chunk",
          );
        })
        .finally(() => {
          open.delete(handle);
          release();
        });
    }

    function send(message: { type: "partial" | "final"; text: string }): void {
      if (done || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_OUTGOING_BYTES) {
        finish(1013);
        return;
      }
      ws.send(JSON.stringify(message));
    }

    const armIdle = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(1008, "idle_timeout"), IDLE_TIMEOUT_MS);
    };
    const sessionTimer = setTimeout(() => finish(1008, "session_limit"), MAX_SESSION_MS);
    armIdle();

    /** Reserves the next chunk when there is none or the current one is full; false when the stream ended. */
    async function ensureChunk(): Promise<boolean> {
      if (chunk !== null && chunkBytesUsed < chunkCapacityBytes) return true;
      await closeChunk();
      if (done) return false;
      let reserved: AudioStreamChunk;
      try {
        reserved = await inTenant(() =>
          reserveAudioStreamChunk(pool, {
            provider: options.provider.id,
            model: options.provider.model,
            operation: STT_STREAM_OPERATION,
            estimatedCostUsd: chunkCostUsd,
            globalCaps: options.globalCaps,
          }),
        );
      } catch (err) {
        if (done) return false;
        if (err instanceof BudgetExceededError) {
          finish(1008, "budget_exceeded");
          return false;
        }
        if (err instanceof ChokePointError) {
          // A tenant that is not active is refused like any other attribution failure, without detail.
          logger.warn({ code: err.code }, "Speech-to-text stream refused at chunk reservation");
          finish(1008);
          return false;
        }
        throw err;
      }
      if (done) {
        await inTenant(() => reserved.fail());
        return false;
      }
      chunk = reserved;
      unattributed.push(reserved);
      return true;
    }

    async function openSession(): Promise<boolean> {
      if (session !== null) return true;
      try {
        const opened = await options.provider.open({
          language,
          signal: providerAbort.signal,
          events: {
            onPartial: (text) => send({ type: "partial", text }),
            onFinal: (text) => send({ type: "final", text }),
            onDone: () => finish(1000),
            onError: (err) => {
              logger.error(
                { err: { name: err.name }, provider: options.provider.id },
                "Speech-to-text provider failed",
              );
              finish(1011, "provider_error");
            },
          },
        });
        if (done) {
          opened.abort();
          return false;
        }
        session = opened;
        return true;
      } catch (err) {
        if (done) return false;
        logger.error(
          { err: { name: err instanceof Error ? err.name : "unknown" }, provider: options.provider.id },
          "Speech-to-text provider failed to open",
        );
        finish(1011, "provider_error");
        return false;
      }
    }

    async function handleAudio(frame: Buffer): Promise<void> {
      if (done) return;
      if (ended || frame.length === 0 || frame.length % 2 !== 0) {
        finish(1008, "invalid_frame");
        return;
      }
      let offset = 0;
      while (offset < frame.length && !done) {
        if (!(await ensureChunk()) || !(await openSession())) return;
        const bytes = Math.min(frame.length - offset, chunkCapacityBytes - chunkBytesUsed);
        session?.write(frame.subarray(offset, offset + bytes));
        if (done) return;
        chunkBytesUsed += bytes;
        offset += bytes;
      }
    }

    /** Attributes the chunks reserved so far to the message; a message the tenant cannot see ends the stream. */
    async function handleAttribute(sempMessageId: string): Promise<void> {
      const chunks = unattributed;
      try {
        await inTenant(() => attributeAudioStreamChunks(pool, chunks, sempMessageId));
      } catch (err) {
        if (err instanceof ChokePointError) {
          // Refused like a refused reservation: without detail, and the rows stay as they were.
          logger.warn({ code: err.code }, "Speech-to-text stream refused an attribution");
          finish(1008);
          return;
        }
        throw err;
      }
      unattributed = [];
    }

    async function handleText(raw: Buffer): Promise<void> {
      if (done) return;
      let value: unknown;
      try {
        value = JSON.parse(raw.toString("utf8"));
      } catch {
        finish(1008, "invalid_frame");
        return;
      }
      const message = controlMessageSchema.safeParse(value);
      if (!message.success) {
        finish(1008, "invalid_frame");
        return;
      }
      if (message.data.type === "attribute") {
        await handleAttribute(message.data.sempMessageId);
        return;
      }
      if (ended) {
        finish(1008, "invalid_frame");
        return;
      }
      ended = true;
      if (session === null) {
        finish(1000);
        return;
      }
      session.end();
    }

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (done) return;
      armIdle();
      const frame = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (!isBinary && frame.length > MAX_TEXT_FRAME_BYTES) {
        finish(1009, "invalid_frame");
        return;
      }
      if (pendingBytes + frame.length > MAX_PENDING_BYTES) {
        finish(1013);
        return;
      }
      pendingBytes += frame.length;
      // Frames are processed one at a time, in arrival order, so a reservation in flight never
      // overlaps the next frame's accounting.
      queue = queue
        .then(() => (isBinary ? handleAudio(frame) : handleText(frame)))
        .catch((err: unknown) => {
          logger.error({ err: { name: err instanceof Error ? err.name : "unknown" } }, "Speech-to-text stream failed");
          finish(1011);
        })
        .finally(() => {
          pendingBytes -= frame.length;
        });
    });
    // A disconnect aborts the provider session and fails or settles the open chunk row.
    ws.on("close", () => finish(null));
    ws.on("error", () => finish(null));
  }

  return {
    handleUpgrade(req, socket, head) {
      socket.on("error", () => undefined);
      if (closing) {
        refuseUpgrade(socket, 503, "Service Unavailable");
        return;
      }
      const providedToken = extractBearerToken(req);
      if (!providedToken || !tokensMatch(providedToken, options.internalToken)) {
        refuseUpgrade(socket, 401, "Unauthorized");
        return;
      }
      let tenantId: string | null;
      let language: string | undefined;
      try {
        tenantId = readCallerTenantId(req);
        language = readLanguage(new URL(req.url ?? "/", "http://localhost"));
      } catch (err) {
        if (err instanceof ValidationError) {
          refuseUpgrade(socket, 400, "Bad Request");
          return;
        }
        throw err;
      }
      // Unlike the HTTP routes there is no legacy caller without a tenant: a stream without one
      // could not be attributed to a budget.
      if (tenantId === null) {
        refuseUpgrade(socket, 400, "Bad Request");
        return;
      }
      const tenant = tenantId;
      wss.handleUpgrade(req, socket, head, (ws) => runStream(ws, tenant, language));
    },
    async closeAll() {
      closing = true;
      await Promise.all([...open].map((stream) => stream.drop()));
    },
  };
}
