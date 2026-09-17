import type { WebSocket } from "ws";
import type { OutboundFrame } from "./protocolV1.js";
import { sendWithBackpressure } from "./backpressure.js";

type ItemInvalidateFrame = Extract<OutboundFrame, { type: "invalidate"; scope: "item" }>;

const DEFAULT_DRAIN_POLL_INTERVAL_MS = 250;

/**
 * Per-socket coalescing queue for item-scope invalidations (issue #242's Task): while a client is
 * behind, a burst of updates to the same (databaseId, itemId) collapses to the one frame carrying
 * the newest updatedAt instead of piling up one entry per NOTIFY, so memory stays bounded
 * regardless of how many redundant invalidations arrive before the client drains.
 */
export interface InvalidationCoalescer {
  /** Sends `frame` immediately if `client` has nothing queued and is fully drained; otherwise queues it, replacing any older pending frame for the same (databaseId, itemId). */
  enqueue(client: WebSocket, frame: ItemInvalidateFrame): void;
  /** Drops `client`'s queue and stops polling it — called from the socket's own `close` handler. */
  discard(client: WebSocket): void;
}

export function createInvalidationCoalescer(
  drainPollIntervalMs = DEFAULT_DRAIN_POLL_INTERVAL_MS,
): InvalidationCoalescer {
  const pendingByClient = new WeakMap<WebSocket, Map<string, ItemInvalidateFrame>>();
  // `ws`'s `WebSocket` has no public `'drain'` event — only its internal `Receiver` (inbound
  // decoding) does — so a queued client is polled for `bufferedAmount === 0` instead of waiting on
  // an event that would never fire. One timer per socket, cleared as soon as its queue empties.
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
      // Nothing queued yet and the socket has fully drained: send immediately, the common case.
      if ((!pending || pending.size === 0) && client.bufferedAmount === 0) {
        sendWithBackpressure(client, JSON.stringify(frame));
        return;
      }
      if (!pending) {
        pending = new Map();
        pendingByClient.set(client, pending);
      }
      const key = `${frame.databaseId}:${frame.itemId}`;
      const existing = pending.get(key);
      if (!existing || frame.updatedAt >= existing.updatedAt) pending.set(key, frame);
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
