import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { createCompleteRequestListener, type CompleteHandlerOptions } from "./completeHandler.js";

/**
 * The full request dispatcher for `semprec-ai-gateway`, mirroring `semprec-api`'s `app.ts`
 * pattern: `serve.ts` calls this to get the listener it hands to `http.createServer`, and tests
 * call it the same way to drive a real in-memory server with no process/port of its own to
 * manage.
 */
export function createDispatcher(
  pool: Pool,
  options: CompleteHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const completeListener = createCompleteRequestListener(pool, options);

  return function dispatch(req: IncomingMessage, res: ServerResponse): void {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/internal/complete") {
      void completeListener(req, res);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not found" }));
  };
}
