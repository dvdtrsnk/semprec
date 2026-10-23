import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { createInvalidationCoalescer } from "../invalidationCoalescer.js";
import type { OutboundFrame } from "../protocolV1.js";

type ItemInvalidateFrame = Extract<OutboundFrame, { type: "invalidate"; scope: "item" }>;

function itemFrame(itemId: string, updatedAt: string): ItemInvalidateFrame {
  return { type: "invalidate", scope: "item", databaseId: "db-1", itemId, op: "update", updatedAt };
}

/** A controllable double: `bufferedAmount` is a plain mutable field, not a real socket getter. */
function fakeSocket(): WebSocket & { bufferedAmount: number; sent: string[] } {
  const socket = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    sent: [] as string[],
    send(payload: string) {
      socket.sent.push(payload);
    },
    close: vi.fn(),
  };
  return socket as unknown as WebSocket & { bufferedAmount: number; sent: string[] };
}

describe("createInvalidationCoalescer (issue #242)", () => {
  it("sends immediately when the socket has nothing queued and is fully drained", () => {
    const coalescer = createInvalidationCoalescer();
    const client = fakeSocket();
    coalescer.enqueue(client, itemFrame("item-1", "2026-01-01T00:00:00.000Z"));
    expect(client.sent).toEqual([JSON.stringify(itemFrame("item-1", "2026-01-01T00:00:00.000Z"))]);
  });

  it("collapses a burst of invalidations for the same (databaseId, itemId) into the newest updatedAt while the socket is behind, sending exactly one frame once it drains", async () => {
    const coalescer = createInvalidationCoalescer(10);
    const client = fakeSocket();
    client.bufferedAmount = 5_000_000; // simulates a client that has fallen behind

    for (let i = 0; i < 20; i += 1) {
      coalescer.enqueue(client, itemFrame("item-1", `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`));
    }
    // Nothing sent yet — the socket never drained while all 20 arrived.
    expect(client.sent).toEqual([]);

    client.bufferedAmount = 0;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(client.sent).toHaveLength(1);
    expect(JSON.parse(client.sent[0]!)).toMatchObject({ itemId: "item-1", updatedAt: "2026-01-01T00:00:19.000Z" });
  });

  it("keeps distinct (databaseId, itemId) keys queued independently instead of collapsing across items", async () => {
    const coalescer = createInvalidationCoalescer(10);
    const client = fakeSocket();
    client.bufferedAmount = 5_000_000;

    coalescer.enqueue(client, itemFrame("item-1", "2026-01-01T00:00:00.000Z"));
    coalescer.enqueue(client, itemFrame("item-2", "2026-01-01T00:00:00.000Z"));
    coalescer.enqueue(client, itemFrame("item-1", "2026-01-01T00:00:01.000Z"));

    client.bufferedAmount = 0;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(client.sent).toHaveLength(2);
    const itemIds = client.sent.map((payload) => (JSON.parse(payload) as ItemInvalidateFrame).itemId).sort();
    expect(itemIds).toEqual(["item-1", "item-2"]);
  });

  it("stops polling and drops the queue once discarded, so a closed socket's timer does not fire forever", async () => {
    const coalescer = createInvalidationCoalescer(10);
    const client = fakeSocket();
    client.bufferedAmount = 5_000_000;
    coalescer.enqueue(client, itemFrame("item-1", "2026-01-01T00:00:00.000Z"));

    coalescer.discard(client);
    client.bufferedAmount = 0;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(client.sent).toEqual([]);
  });
});
