import type { WebSocket } from "ws";
import type { OutboundFrame } from "./protocolV1.js";
import { sendWithBackpressure } from "./backpressure.js";

type ItemInvalidateFrame = Extract<OutboundFrame, { type: "invalidate"; scope: "item" }>;
type RelationInvalidateFrame = Extract<OutboundFrame, { type: "invalidate"; scope: "relation" }>;
type CoalescedFrame = ItemInvalidateFrame | RelationInvalidateFrame;

const DEFAULT_DRAIN_POLL_INTERVAL_MS = 250;

/**
 * Per-socket coalescing for item-scope invalidations: while a client is behind, updates to the same (databaseId,
 * itemId) collapse to one frame with the newest updatedAt, so memory stays bounded however many redundant invalidations
 * arrive.
 */
export interface InvalidationCoalescer {
  /**
   * Sends immediately when drained; otherwise replaces pending item frames by (databaseId, itemId) and relation frames
   * by (itemId, propertyKey), null included.
   */
  enqueue(client: WebSocket, frame: CoalescedFrame): void;
  /** Called from the socket's `close` handler. */
  discard(client: WebSocket): void;
}

export function createInvalidationCoalescer(
  drainPollIntervalMs = DEFAULT_DRAIN_POLL_INTERVAL_MS,
): InvalidationCoalescer {
  const pendingByClient = new WeakMap<WebSocket, Map<string, CoalescedFrame>>();
  // `ws` exposes no public `'drain'` event, so a queued client is polled for `bufferedAmount === 0`. One timer per
  // socket, cleared once its queue empties.
  const drainPollers = new Map<WebSocket, NodeJS.Timeout>();

  function flush(client: WebSocket): void {
    const pending = pendingByClient.get(client);
    if (!pending || pending.size === 0) return;
    const frames = [...pending.values()];
    pending.clear();
    for (const frame of frames) sendWithBackpressure(client, JSON.stringify(frame));
  }

  function stopPoll(client: WebSocket): void {
    const poller = drainPollers.get(client);
    if (poller) {
      clearInterval(poller);
      drainPollers.delete(client);
    }
  }

  return {
    enqueue(client, frame) {
      let pending = pendingByClient.get(client);
      if ((!pending || pending.size === 0) && client.bufferedAmount === 0) {
        sendWithBackpressure(client, JSON.stringify(frame));
        return;
      }
      if (!pending) {
        pending = new Map();
        pendingByClient.set(client, pending);
      }
      const key =
        frame.scope === "item"
          ? JSON.stringify(["item", frame.databaseId, frame.itemId])
          : JSON.stringify(["relation", frame.itemId, frame.propertyKey]);
      const existing = pending.get(key);
      if (frame.scope === "relation" || !existing || existing.scope !== "item" || frame.updatedAt >= existing.updatedAt)
        pending.set(key, frame);
      if (!drainPollers.has(client)) {
        const poller = setInterval(() => {
          if (client.readyState !== client.OPEN) {
            stopPoll(client);
            return;
          }
          if (client.bufferedAmount === 0) {
            stopPoll(client);
            flush(client);
          }
        }, drainPollIntervalMs);
        drainPollers.set(client, poller);
      }
    },
    discard(client) {
      pendingByClient.delete(client);
      stopPoll(client);
    },
  };
}
