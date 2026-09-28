import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createCompleteRequestListener, type CompleteHandlerOptions } from "./completeHandler.js";
import { createAudioRequestListener, type AudioHandlerOptions } from "./audioHandler.js";
import { createAudioConcurrencyLimit, MAX_CONCURRENT_AUDIO_REQUESTS } from "./audioConcurrencyLimit.js";

/**
 * The full request dispatcher for `semprec-ai-gateway`, mirroring `semprec-api`'s `app.ts`
 * pattern: `serve.ts` calls this to get the listener it hands to `http.createServer`, and tests
 * call it the same way to drive a real in-memory server with no process/port of its own to
 * manage.
 */
export function createDispatcher(
  pool: Pool,
  options: CompleteHandlerOptions,
  audioOptions: AudioHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const completeListener = createCompleteRequestListener(pool, options);
  const audioListener = createAudioRequestListener(pool, audioOptions);
  const audioLimit = createAudioConcurrencyLimit(MAX_CONCURRENT_AUDIO_REQUESTS);

  return function dispatch(req: IncomingMessage, res: ServerResponse): void {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/internal/complete") {
      void completeListener(req, res);
      return;
    }
    if (pathname === "/internal/diarize" || pathname === "/internal/transcribe") {
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
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not found" }));
  };
}
