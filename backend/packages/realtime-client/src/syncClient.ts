import type { AgentRunEventRow, NotificationRow } from "@alldots/data";
import {
  buildBinaryFrame,
  decodeDocId,
  parseBinaryFrame,
  SESSION_REVOKED_CLOSE_CODE,
  type AgentDeltaChunk,
  type InboundFrame,
  type OutboundFrame,
} from "@alldots/realtime";
import type { Doc as YDoc } from "yjs";
import { nextReconnectDelayMs } from "./backoff.js";
import { createDocSession, type DocSession } from "./docSession.js";
import { parseServerFrame } from "./serverFrame.js";

/** `WebSocket.readyState`'s `OPEN` value in both `ws` and the browser API. */
const OPEN_READY_STATE = 1;

type RawSocketData = string | Buffer | ArrayBuffer | Buffer[];

/** The WebSocket surface this client needs, satisfied by both `ws` and the browser's `WebSocket`. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onmessage: ((event: { data: RawSocketData }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface SyncClientOptions {
  /** Opens one fresh `WS /api/sync` connection. Called again, with a growing backoff, after every drop. */
  createSocket: () => WebSocketLike;
  /**
   * Re-runs every REST fetch the displayed state depends on (active-view queries, the open item), once per
   * successful connect including the first. `invalidate` frames received while it is in flight are dropped, not
   * queued, since the refetch already carries what they would say. Omit it if nothing displayed is ever invalidated.
   */
  refetchActiveState?: () => Promise<void>;
  /** One-time `GET /api/notifications/unread` equivalent, called once per successful connect. */
  fetchUnreadNotifications?: () => Promise<void>;
  onInvalidate?: (frame: Extract<OutboundFrame, { type: "invalidate" }>) => void;
  onNotification?: (notification: NotificationRow) => void;
  onAgentEvent?: (agentRunId: string, event: AgentRunEventRow) => void;
  onAgentDelta?: (agentRunId: string, delta: unknown, chunk: AgentDeltaChunk | undefined) => void;
  /** The server stored the doc update that carried `clientUpdateId`. */
  onDocAck?: (docId: string, clientUpdateId: string) => void;
  /** The session was revoked (close code 4401) — terminal, this client will not reconnect on its own. */
  onSessionRevoked?: () => void;
  /** Observability hook: a reconnect attempt was just scheduled `delayMs` from now. */
  onReconnecting?: (attempt: number, delayMs: number) => void;
  /** Injected for deterministic tests; defaults to `Math.random`. */
  random?: () => number;
}

export interface SyncClient {
  /** Opens the first connection (or the next one, if `close()` had been called). Idempotent while already connecting/open/waiting. */
  connect(): void;
  /** Closes intentionally: no further reconnect attempt follows. */
  close(): void;
  /** Subscribes to `docId`, resuming automatically on every future reconnect until `closeDoc`. */
  openDoc(docId: string, ydoc?: YDoc): DocSession;
  closeDoc(docId: string): void;
  /** Watches `runId` from `afterEventId`, resuming automatically from its latest delivered cursor on every future reconnect. */
  watchAgentRun(runId: string, afterEventId: string): void;
  unwatchAgentRun(runId: string): void;
}

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

/**
 * The `WS /api/sync` client: reconnects after a drop with exponential backoff and jitter, then runs
 * each stream's own recovery path (no universal cursor). Typed against `@alldots/realtime`'s
 * protocol so wire-format changes fail to compile.
 */
export function createSyncClient(options: SyncClientOptions): SyncClient {
  let socket: WebSocketLike | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let closedByCaller = true;
  let gateInvalidations = false;
  // Bumped per `establishConnection()` so a superseded socket's handlers recognize themselves as stale and no-op.
  let connectionId = 0;

  const openDocs = new Map<string, DocSession>();
  const watchedRuns = new Map<string, { lastEventId: string }>();

  function sendFrame(frame: InboundFrame): void {
    if (!socket || socket.readyState !== OPEN_READY_STATE) return;
    socket.send(JSON.stringify(frame));
  }

  function sendDocPayload(docId: string, payload: Uint8Array): void {
    if (!socket || socket.readyState !== OPEN_READY_STATE) return;
    socket.send(buildBinaryFrame(docId, payload));
  }

  function dispatchFrame(frame: OutboundFrame): void {
    switch (frame.type) {
      case "invalidate":
        // Dropped while this connection's active-state refetch is in flight, which supersedes it; the server never
        // replays invalidations published while a socket was disconnected.
        if (!gateInvalidations) options.onInvalidate?.(frame);
        return;
      case "notification":
        options.onNotification?.(frame.notification);
        return;
      case "agent:event": {
        const watch = watchedRuns.get(frame.agentRunId);
        if (watch) watch.lastEventId = frame.event.id;
        options.onAgentEvent?.(frame.agentRunId, frame.event);
        return;
      }
      case "agent:delta":
        options.onAgentDelta?.(frame.agentRunId, frame.delta, frame.chunk);
        return;
      case "doc:ack":
        options.onDocAck?.(frame.docId, frame.clientUpdateId);
        return;
    }
  }

  function handleBinaryMessage(data: Buffer | ArrayBuffer | Buffer[]): void {
    const frame = parseBinaryFrame(toBuffer(data));
    if (!frame) return;
    const docId = decodeDocId(frame.docId);
    if (!docId) return;
    // Not currently open (e.g. `closeDoc` raced an in-flight frame) — dropped, not an error.
    openDocs.get(docId)?.handlePayload(frame.payload);
  }

  function handleMessage(data: RawSocketData): void {
    if (typeof data === "string") {
      const frame = parseServerFrame(data);
      if (frame) dispatchFrame(frame);
      return;
    }
    handleBinaryMessage(data);
  }

  /**
   * Runs once per successful (re)connect: resubscribes every open doc and watched agent run from its
   * own last cursor, then gates `invalidate` delivery on the active-state refetch. Doc and agent-run
   * recovery are deliberately not gated on that refetch.
   */
  function recoverAfterConnect(myConnectionId: number): void {
    for (const docId of openDocs.keys()) sendFrame({ type: "doc:open", docId });
    for (const [runId, watch] of watchedRuns)
      sendFrame({ type: "agent:watch", runId, afterEventId: watch.lastEventId });

    options.fetchUnreadNotifications?.().catch((err: unknown) => {
      console.error("Sync client failed to fetch unread notifications after connect", err);
    });

    gateInvalidations = true;
    const refetch = options.refetchActiveState?.() ?? Promise.resolve();
    refetch
      .catch((err: unknown) => {
        // Logged, and the gate still lifts below so one failed fetch does not leave the client deaf to
        // invalidations; the next write still arrives live.
        console.error("Sync client failed to refetch active state after connect", err);
      })
      .finally(() => {
        // A superseded attempt's late refetch must not lift the current attempt's gate.
        if (myConnectionId === connectionId) gateInvalidations = false;
      });
  }

  function scheduleReconnect(): void {
    if (closedByCaller) return;
    const delay = nextReconnectDelayMs(reconnectAttempt, options.random);
    reconnectAttempt += 1;
    options.onReconnecting?.(reconnectAttempt, delay);
    reconnectTimer = setTimeout(() => establishConnection(), delay);
  }

  function establishConnection(): void {
    if (closedByCaller) return;
    const myConnectionId = ++connectionId;
    const ws = options.createSocket();
    socket = ws;
    ws.onopen = () => {
      if (myConnectionId !== connectionId) return;
      reconnectAttempt = 0;
      recoverAfterConnect(myConnectionId);
    };
    ws.onmessage = (event) => {
      if (myConnectionId !== connectionId) return;
      handleMessage(event.data);
    };
    // `onerror` must be set even without a caller listener: a null handler surfaces as an unhandled error in some
    // implementations (`ws` included) instead of the `close` event handled next.
    ws.onerror = (err: unknown) => {
      console.error("Sync client socket error", err);
    };
    ws.onclose = (event) => {
      // A stale socket's close must not clobber the connection that superseded it.
      if (myConnectionId !== connectionId) return;
      socket = null;
      if (event.code === SESSION_REVOKED_CLOSE_CODE) {
        // Terminal: a revoked session fails authentication on every retry.
        closedByCaller = true;
        options.onSessionRevoked?.();
        return;
      }
      scheduleReconnect();
    };
  }

  return {
    connect() {
      closedByCaller = false;
      if (socket || reconnectTimer) return;
      establishConnection();
    },
    close() {
      closedByCaller = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      reconnectAttempt = 0;
      socket?.close(1000, "client closed");
      socket = null;
    },
    openDoc(docId, ydoc) {
      const existing = openDocs.get(docId);
      if (existing) return existing;
      const session = createDocSession(docId, (payload) => sendDocPayload(docId, payload), ydoc);
      openDocs.set(docId, session);
      sendFrame({ type: "doc:open", docId });
      return session;
    },
    closeDoc(docId) {
      const session = openDocs.get(docId);
      if (!session) return;
      session.dispose();
      openDocs.delete(docId);
      sendFrame({ type: "doc:close", docId });
    },
    watchAgentRun(runId, afterEventId) {
      watchedRuns.set(runId, { lastEventId: afterEventId });
      sendFrame({ type: "agent:watch", runId, afterEventId });
    },
    unwatchAgentRun(runId) {
      if (!watchedRuns.delete(runId)) return;
      sendFrame({ type: "agent:unwatch", runId });
    },
  };
}
