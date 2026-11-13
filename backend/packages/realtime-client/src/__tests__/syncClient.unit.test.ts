import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncClient, type WebSocketLike } from "../syncClient.js";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string | Buffer | ArrayBuffer | Buffer[] }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  /** Test-only: simulates the server completing the WS handshake. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Test-only: simulates a server-initiated close (a fault, a revoke, ...). */
  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** Test-only: delivers one text (JSON) frame as if it arrived from the server. */
  receiveFrame(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function sentFrames(socket: FakeSocket): unknown[] {
  return socket.sent.filter((data): data is string => typeof data === "string").map((data) => JSON.parse(data));
}

// The invalidate branch of parseServerFrame at d99edb8a0b7a3a09aa0028d8ecbea1c42b7af2a8.
function recordedOldInvalidation(parsed: Record<string, unknown>): unknown {
  if (parsed.scope === "item") {
    const { databaseId, itemId, op, updatedAt } = parsed;
    if (typeof databaseId !== "string" || typeof itemId !== "string" || typeof updatedAt !== "string") return null;
    if (op !== "create" && op !== "update" && op !== "delete") return null;
    return { type: "invalidate", scope: "item", databaseId, itemId, op, updatedAt };
  }
  if (parsed.scope === "schema") {
    const { databaseId } = parsed;
    return typeof databaseId === "string" ? { type: "invalidate", scope: "schema", databaseId } : null;
  }
  if (parsed.scope === "sempThread") {
    const { threadId } = parsed;
    return typeof threadId === "string" ? { type: "invalidate", scope: "sempThread", threadId } : null;
  }
  return null;
}

describe("createSyncClient (issue #164)", () => {
  let sockets: FakeSocket[];

  beforeEach(() => {
    sockets = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createSocket(): FakeSocket {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  }

  it("the recorded older invalidate handler accepts its known scopes and ignores relation", () => {
    expect(recordedOldInvalidation({ scope: "schema", databaseId: "db" })).toEqual({
      type: "invalidate",
      scope: "schema",
      databaseId: "db",
    });
    expect(
      recordedOldInvalidation({ scope: "relation", databaseId: "db", itemId: "item", propertyKey: "links", op: "put" }),
    ).toBeNull();
  });

  it("exposes a relation invalidation after the initial refetch", async () => {
    const onInvalidate = vi.fn();
    const client = createSyncClient({ createSocket, refetchActiveState: async () => {}, onInvalidate });
    client.connect();
    const socket = sockets[0]!;
    socket.open();
    await Promise.resolve();
    await Promise.resolve();
    const frame = {
      type: "invalidate",
      scope: "relation",
      databaseId: "db",
      itemId: "item",
      propertyKey: null,
      op: "put",
    };
    socket.receiveFrame(frame);
    expect(onInvalidate).toHaveBeenCalledWith(frame);
  });

  it("exposes a mailThread invalidation after the initial refetch and drops a malformed one (issue #1816)", async () => {
    const onInvalidate = vi.fn();
    const client = createSyncClient({ createSocket, refetchActiveState: async () => {}, onInvalidate });
    client.connect();
    const socket = sockets[0]!;
    socket.open();
    await Promise.resolve();
    await Promise.resolve();

    socket.receiveFrame({ type: "invalidate", scope: "mailThread", threadId: 7 });
    expect(onInvalidate).not.toHaveBeenCalled();

    const frame = { type: "invalidate", scope: "mailThread", threadId: "9d0c7a52-5b1e-4f3a-8c26-1e4b7d9a3f05" };
    socket.receiveFrame(frame);
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    expect(onInvalidate).toHaveBeenCalledWith(frame);
  });

  it("exposes an inboxCards invalidation after the initial refetch and drops a malformed one (issue #1811)", async () => {
    const onInvalidate = vi.fn();
    const client = createSyncClient({ createSocket, refetchActiveState: async () => {}, onInvalidate });
    client.connect();
    const socket = sockets[0]!;
    socket.open();
    await Promise.resolve();
    await Promise.resolve();
    const cardId = "6b2f0c1e-8a47-4d63-b1f5-0e9d3c7a5b12";

    socket.receiveFrame({ type: "invalidate", scope: "inboxCards", op: "closed", cardId: "card-1" });
    expect(onInvalidate).not.toHaveBeenCalled();

    const frame = { type: "invalidate", scope: "inboxCards", op: "closed", cardId };
    socket.receiveFrame(frame);
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    expect(onInvalidate).toHaveBeenCalledWith(frame);
  });

  it("drops an inboxCards invalidation that arrives before the active-state refetch resolves (issue #1811)", async () => {
    let finishRefetch: () => void = () => {};
    const refetchActiveState = vi.fn(() => new Promise<void>((resolve) => (finishRefetch = resolve)));
    const onInvalidate = vi.fn();
    const client = createSyncClient({ createSocket, refetchActiveState, onInvalidate });
    client.connect();
    const socket = sockets[0]!;
    socket.open();

    socket.receiveFrame({
      type: "invalidate",
      scope: "inboxCards",
      op: "created",
      cardId: "6b2f0c1e-8a47-4d63-b1f5-0e9d3c7a5b12",
    });
    expect(onInvalidate).not.toHaveBeenCalled();

    finishRefetch();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("runs refetchActiveState and fetchUnreadNotifications once on the first successful connect", async () => {
    const refetchActiveState = vi.fn().mockResolvedValue(undefined);
    const fetchUnreadNotifications = vi.fn().mockResolvedValue(undefined);
    const client = createSyncClient({ createSocket, refetchActiveState, fetchUnreadNotifications });

    client.connect();
    sockets[0]!.open();
    await vi.waitFor(() => expect(refetchActiveState).toHaveBeenCalledTimes(1));
    expect(fetchUnreadNotifications).toHaveBeenCalledTimes(1);
  });

  it("drops an invalidation that arrives before the active-state refetch resolves, then delivers a later one", async () => {
    let resolveRefetch!: () => void;
    const refetchActiveState = vi.fn(() => new Promise<void>((resolve) => (resolveRefetch = resolve)));
    const onInvalidate = vi.fn();
    const client = createSyncClient({ createSocket, refetchActiveState, onInvalidate });

    client.connect();
    const socket = sockets[0]!;
    socket.open();

    socket.receiveFrame({ type: "invalidate", scope: "schema", databaseId: "db-1" });
    expect(onInvalidate).not.toHaveBeenCalled();

    resolveRefetch();
    await vi.waitFor(() => expect(refetchActiveState).toHaveBeenCalledTimes(1));
    // Flush the microtask queue the refetch promise's `.finally` runs on.
    await Promise.resolve();
    await Promise.resolve();

    socket.receiveFrame({ type: "invalidate", scope: "schema", databaseId: "db-2" });
    expect(onInvalidate).toHaveBeenCalledTimes(1);
    expect(onInvalidate).toHaveBeenCalledWith({ type: "invalidate", scope: "schema", databaseId: "db-2" });
  });

  it("delivers a notification frame immediately, never gated behind the active-state refetch", async () => {
    let resolveRefetch!: () => void;
    const refetchActiveState = vi.fn(() => new Promise<void>((resolve) => (resolveRefetch = resolve)));
    const onNotification = vi.fn();
    const client = createSyncClient({ createSocket, refetchActiveState, onNotification });

    client.connect();
    const socket = sockets[0]!;
    socket.open();

    const notification = {
      id: "n1",
      userId: "u1",
      kind: "system",
      title: "Hello",
      body: null,
      linkHref: null,
      sourceTable: "items",
      sourceId: "i1",
      transitionInstance: "t1",
      payload: {},
      createdAt: new Date().toISOString(),
      readAt: null,
    };
    socket.receiveFrame({ type: "notification", notification });
    expect(onNotification).toHaveBeenCalledWith(notification);
    resolveRefetch();
  });

  it("resubscribes every open doc and watched agent run — from its latest cursor — on every reconnect", async () => {
    const client = createSyncClient({ createSocket, random: () => 0 });
    client.connect();
    const first = sockets[0]!;
    first.open();

    client.openDoc("11111111-1111-1111-1111-111111111111");
    client.watchAgentRun("22222222-2222-2222-2222-222222222222", "0");
    // The agent stream advances this run's cursor before the drop below.
    first.receiveFrame({
      type: "agent:event",
      agentRunId: "22222222-2222-2222-2222-222222222222",
      event: {
        id: "7",
        agentRunId: "22222222-2222-2222-2222-222222222222",
        kind: "turn_start",
        payload: {},
        at: new Date().toISOString(),
      },
    });

    first.serverClose(1012, "listen connection lost");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sockets).toHaveLength(2);
    const second = sockets[1]!;
    second.open();

    const frames = sentFrames(second);
    expect(frames).toContainEqual({ type: "doc:open", docId: "11111111-1111-1111-1111-111111111111" });
    expect(frames).toContainEqual({
      type: "agent:watch",
      runId: "22222222-2222-2222-2222-222222222222",
      afterEventId: "7",
    });
  });

  it("dispatches a doc:ack frame to onDocAck and drops a malformed one", () => {
    const onDocAck = vi.fn();
    const client = createSyncClient({ createSocket, onDocAck });
    client.connect();
    const socket = sockets[0]!;
    socket.open();

    socket.receiveFrame({ type: "doc:ack", docId: "d1", clientUpdateId: "edit-1" });
    expect(onDocAck).toHaveBeenCalledExactlyOnceWith("d1", "edit-1");

    socket.receiveFrame({ type: "doc:ack", docId: "d1" });
    socket.receiveFrame({ type: "doc:ack", docId: 5, clientUpdateId: "edit-2" });
    socket.receiveFrame({ type: "doc:ack", docId: "d1", clientUpdateId: "bad id" });
    socket.receiveFrame({ type: "doc:ack", docId: "d1", clientUpdateId: "a".repeat(65) });
    expect(onDocAck).toHaveBeenCalledTimes(1);
  });

  it("reconnects with the injected backoff delay after a server-initiated drop", async () => {
    const client = createSyncClient({ createSocket, random: () => 0 });
    client.connect();
    sockets[0]!.open();
    sockets[0]!.serverClose(1013, "slow consumer");

    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
  });

  it("stops reconnecting on a 4401 session-revoked close and reports it as terminal", async () => {
    const onSessionRevoked = vi.fn();
    const client = createSyncClient({ createSocket, onSessionRevoked });
    client.connect();
    sockets[0]!.open();
    sockets[0]!.serverClose(4401, "session revoked");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
    expect(onSessionRevoked).toHaveBeenCalledTimes(1);
  });

  it("never reconnects after an intentional close() even past the backoff window", async () => {
    const client = createSyncClient({ createSocket, random: () => 0 });
    client.connect();
    sockets[0]!.open();

    client.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });

  it("restarts the backoff from the first attempt after close() and a fresh connect()", async () => {
    const onReconnecting = vi.fn();
    const client = createSyncClient({ createSocket, random: () => 0, onReconnecting });
    client.connect();
    sockets[0]!.serverClose(1013, "slow consumer");
    await vi.advanceTimersByTimeAsync(1_000);
    sockets[1]!.serverClose(1013, "slow consumer");
    expect(onReconnecting).toHaveBeenLastCalledWith(2, expect.any(Number));

    client.close();
    client.connect();
    sockets[2]!.serverClose(1013, "slow consumer");
    expect(onReconnecting).toHaveBeenLastCalledWith(1, expect.any(Number));
  });
});
