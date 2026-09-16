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
      event: { id: "7", agentRunId: "22222222-2222-2222-2222-222222222222", kind: "turn_start", payload: {}, at: new Date().toISOString() },
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
});
