import type { WebSocket } from "ws";

/**
 * Every stream type (protocol-v1 text frames, agent event/delta frames, doc-sync binary frames)
 * sends through this one gate rather than calling `ws.send` directly, so "never silently drop a
 * frame, close instead" (issue #242's Task) is enforced once, not re-implemented per stream.
 */
export const MAX_BUFFERED_BYTES = 4_000_000;

/** WS close code for "try again later" (RFC 6455) — used when a slow consumer's outgoing buffer stays over `MAX_BUFFERED_BYTES`. */
export const BACKPRESSURE_CLOSE_CODE = 1013;

/**
 * Sends `payload` unless `ws`'s outgoing buffer is already over the backpressure threshold, in
 * which case the connection is closed instead — a slow consumer that never drains never
 * accumulates an unbounded queue, and no caller has to choose between silently dropping a frame
 * and blocking on a client that may never catch up.
 */
export function sendWithBackpressure(ws: WebSocket, payload: string | Buffer): void {
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    ws.close(BACKPRESSURE_CLOSE_CODE, "backpressure");
    return;
  }
  ws.send(payload);
}
