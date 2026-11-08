import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Pool } from "pg";
import { synthesizeSpeech, type HttpAiGatewayClientConfig } from "@semprec/ai-gateway-client";
import { AiGatewayFailedError, runInTenant } from "@semprec/shared";
import {
  ChokePointError,
  getMessageSpeech,
  getMessageSpeechSource,
  messageSpeechStagedBlobExists,
  MessageSpeechCapacityError,
  storeMessageSpeech,
  tenantBlobStorageKey,
  ValidationError,
  withMessageSpeechGuard,
  withTransaction,
  type BlobStorageWriter,
} from "@semprec/data";
import { authenticateRequest } from "./authHandler.js";
import { statusForError, toErrorResponseBody } from "./adapter/errorContract.js";
import { NO_STORE, PayloadTooLargeError, readRawBody, sendJson } from "./adapter/http.js";
import { assertUuid } from "./adapter/requestValidation.js";
import { logger } from "./logger.js";

export const MESSAGE_SPEECH_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
] as const;
export const DEFAULT_MESSAGE_SPEECH_VOICE = "alloy";
const SPEECH_PATH = /^\/api\/semp\/threads\/([^/]+)\/messages\/([^/]+)\/speech$/;
const SPEECH_MAX_BYTES = 32 * 1024 * 1024;
const SPEECH_TIMEOUT_MS = 5 * 60_000;

export function isMessageSpeechPath(path: string): boolean {
  return SPEECH_PATH.test(path);
}

export function createSempSpeechRequestListener(
  pool: Pool,
  storage: BlobStorageWriter,
  gateway?: HttpAiGatewayClientConfig,
) {
  return function handle(req: IncomingMessage, res: ServerResponse): void {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once("close", abort);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(SPEECH_TIMEOUT_MS)]);
    const execute = async () => {
      const identity = await authenticateRequest(pool, req);
      signal.throwIfAborted();
      const stopBody = () => req.destroy();
      signal.addEventListener("abort", stopBody, { once: true });
      try {
        if (signal.aborted) stopBody();
        await readRawBody(req, { maxBytes: 1024 });
      } finally {
        signal.removeEventListener("abort", stopBody);
      }
      signal.throwIfAborted();
      const url = new URL(req.url ?? "/", "http://localhost");
      const match = SPEECH_PATH.exec(url.pathname);
      if (!match?.[1] || !match[2]) throw new ValidationError("Invalid message path", { field: "messageId" });
      const threadId = assertUuid(match[1], "threadId");
      const messageId = assertUuid(match[2], "messageId");
      const voices = url.searchParams.getAll("voice");
      const voice = voices.length === 0 ? DEFAULT_MESSAGE_SPEECH_VOICE : voices[0];
      if (voices.length > 1 || voice === undefined || !MESSAGE_SPEECH_VOICES.some((candidate) => candidate === voice)) {
        throw new ValidationError("Invalid voice", { field: "voice" });
      }
      const blob = await runInTenant(identity.tenantId, async () => {
        await withTransaction(pool, (client) => getMessageSpeechSource(client, threadId, messageId));
        signal.throwIfAborted();
        let stagedKey: string | undefined;
        let operationFailure: unknown;
        try {
          return await withMessageSpeechGuard(pool, messageId, voice, signal, async (guardSignal) => {
            const source = await withTransaction(pool, async (client) => {
              const text = await getMessageSpeechSource(client, threadId, messageId);
              guardSignal.throwIfAborted();
              const cached = await getMessageSpeech(client, messageId, voice);
              guardSignal.throwIfAborted();
              return { text, cached };
            });
            guardSignal.throwIfAborted();
            if (source.cached) return source.cached;
            if (!gateway) throw new MessageSpeechCapacityError();
            const key = await withTransaction(pool, (client) => tenantBlobStorageKey(client, `blobs/${randomUUID()}`));
            guardSignal.throwIfAborted();
            stagedKey = key;
            const audio = await synthesizeSpeech(gateway, { text: source.text, voice, signal: guardSignal });
            guardSignal.throwIfAborted();
            const readable = Readable.from(audio);
            const cancel = () => readable.destroy(new Error("Speech request cancelled"));
            guardSignal.addEventListener("abort", cancel, { once: true });
            let byteSize: number;
            try {
              if (guardSignal.aborted) cancel();
              ({ byteSize } = await storage.writeStream(key, readable, { maxBytes: SPEECH_MAX_BYTES }));
            } finally {
              guardSignal.removeEventListener("abort", cancel);
              readable.destroy();
            }
            guardSignal.throwIfAborted();
            const stored = await withTransaction(pool, async (client) => {
              const result = await storeMessageSpeech(client, {
                threadId,
                messageId,
                voice,
                text: source.text,
                storageKey: key,
                byteSize,
              });
              guardSignal.throwIfAborted();
              return result;
            });
            if (!stored.created) {
              await storage.delete(key);
              stagedKey = undefined;
            }
            return stored.blob;
          });
        } catch (error) {
          operationFailure = error;
        }
        if (stagedKey !== undefined) {
          const key = stagedKey;
          try {
            const exists = await withTransaction(pool, (client) =>
              messageSpeechStagedBlobExists(client, messageId, key),
            );
            if (!exists) await storage.delete(key);
          } catch (cleanupError) {
            throw new AggregateError([operationFailure, cleanupError], "Speech fill and cleanup failed", {
              // The fill failure remains primary; the caught cleanup failure is retained in errors.
              // eslint-disable-next-line preserve-caught-error
              cause: operationFailure,
            });
          }
        }
        throw operationFailure instanceof Error
          ? operationFailure
          : new Error("Speech fill failed", { cause: operationFailure });
      });
      signal.throwIfAborted();
      const stream = storage.readStream(blob.storageKey);
      try {
        await once(stream, "readable", { signal });
        signal.throwIfAborted();
      } catch (error) {
        stream.destroy();
        throw error;
      }
      res.writeHead(200, {
        "Content-Type": blob.mimeType,
        "Content-Length": blob.byteSize,
        "Cache-Control": NO_STORE,
        "X-Content-Type-Options": "nosniff",
      });
      await pipeline(stream, res, { signal });
    };
    execute()
      .catch((error: unknown) => {
        if (res.destroyed) return;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (error instanceof PayloadTooLargeError) {
          sendJson(res, 413, { error: { code: "payload_too_large" } });
        } else if (error instanceof AiGatewayFailedError && error.reason === "budget_exceeded") {
          sendJson(res, 403, { error: { code: "budget_exceeded" } });
        } else if (error instanceof ChokePointError) {
          sendJson(res, statusForError(error), toErrorResponseBody(error));
        } else if (error instanceof MessageSpeechCapacityError) {
          sendJson(res, 503, { error: { code: "overloaded" } });
        } else {
          logger.error({ errorName: error instanceof Error ? error.name : "unknown" }, "Speech request failed");
          sendJson(res, 500, { error: { code: "internal_error" } });
        }
      })
      .finally(() => res.off("close", abort));
  };
}
