import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createCompleteRequestListener, type CompleteHandlerOptions } from "./completeHandler.js";
import { createAudioRequestListener, type AudioHandlerOptions } from "./audioHandler.js";

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

  return function dispatch(req: IncomingMessage, res: ServerResponse): void {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/internal/complete") {
      void completeListener(req, res);
      return;
    }
    if (pathname === "/internal/diarize" || pathname === "/internal/transcribe") {
      void audioListener(req, res);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not found" }));
  };
}
