import type { WebSocket } from "ws";

/**
 * Every stream sends through this one gate instead of `ws.send`, so "never silently drop a frame, close instead" is
 * enforced once.
 */
export const MAX_BUFFERED_BYTES = 4_000_000;

/** RFC 6455 "try again later", for a slow consumer whose buffer stays over `MAX_BUFFERED_BYTES`. */
export const BACKPRESSURE_CLOSE_CODE = 1013;

/**
 * Closes the connection instead of sending when the buffer is over the threshold: no unbounded queue, and no caller has
 * to choose between dropping a frame and blocking on a client that may never catch up.
 */
export function sendWithBackpressure(ws: WebSocket, payload: string | Buffer): void {
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    ws.close(BACKPRESSURE_CLOSE_CODE, "backpressure");
    return;
  }
  ws.send(payload);
}
