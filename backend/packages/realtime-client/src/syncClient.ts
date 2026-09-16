import type { AgentRunEventRow, NotificationRow } from "@semprec/data";
import {
  buildBinaryFrame,
  decodeDocId,
  parseBinaryFrame,
  SESSION_REVOKED_CLOSE_CODE,
  type AgentDeltaChunk,
  type InboundFrame,
  type OutboundFrame,
} from "@semprec/realtime";
import type { Doc as YDoc } from "yjs";
import { nextReconnectDelayMs } from "./backoff.js";
import { createDocSession, type DocSession } from "./docSession.js";
import { parseServerFrame } from "./serverFrame.js";

/** `WebSocket.readyState`'s `OPEN` value — identical in both `ws` and the browser API. */
const OPEN_READY_STATE = 1;

type RawSocketData = string | Buffer | ArrayBuffer | Buffer[];

/**
 * The minimal structural surface this client needs from a WebSocket — satisfied as-is by both
 * `ws`'s `WebSocket` (used by every test in this package) and the browser's native `WebSocket`,
 * so this module never imports a concrete implementation and stays usable from a future browser
 * client without a rewrite.
 */
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
   * Re-runs every REST fetch this client's currently displayed state depends on (issue #161's
   * active-view queries, the open item) — called once per successful connect, including the
   * first. No `invalidate` frame received before this settles is applied; one received while it
   * is in flight is dropped rather than queued, since the refetch itself already carries whatever
   * that frame would have told this client. Omit it if this client displays nothing invalidation
   * ever targets.
   */
  refetchActiveState?: () => Promise<void>;
  /** One-time `GET /api/notifications/unread` equivalent, called once per successful connect. */
  fetchUnreadNotifications?: () => Promise<void>;
  onInvalidate?: (frame: Extract<OutboundFrame, { type: "invalidate" }>) => void;
  onNotification?: (notification: NotificationRow) => void;
  onAgentEvent?: (agentRunId: string, event: AgentRunEventRow) => void;
  onAgentDelta?: (agentRunId: string, delta: unknown, chunk: AgentDeltaChunk | undefined) => void;
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
 * The `WS /api/sync` client (issue #164's Task): reconnects after a drop with exponential
 * backoff and jitter (`backoff.ts`), then runs every stream's own recovery path on each
 * successful reconnect — no universal cursor. Built against `@semprec/realtime`'s protocol-v1
 * types so a change to the wire format is a compile error here, not a silent drift.
 */
export function createSyncClient(options: SyncClientOptions): SyncClient {
  let socket: WebSocketLike | null = null;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let closedByCaller = true;
  let gateInvalidations = false;

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
        // Dropped, never queued, while this connection's active-state refetch is in flight —
        // that refetch already supersedes whatever this frame would have told the client (see
        // `refetchActiveState`'s doc comment and the server's own "never replays an invalidation
        // published while a socket was disconnected" contract in `syncServer.ts`).
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
   * Runs once per successful (re)connect: resubscribes every open doc and watched agent run from
   * its own last-known cursor — never a universal one — then gates `invalidate` delivery on the
   * active-state refetch this issue's Task requires before any new invalidation is trusted.
   * Yjs/agent-run recovery is deliberately not gated on the same refetch: each stream's Task
   * describes its own independent resume path, not one blocking the others.
   */
  function recoverAfterConnect(): void {
    for (const docId of openDocs.keys()) sendFrame({ type: "doc:open", docId });
    for (const [runId, watch] of watchedRuns) sendFrame({ type: "agent:watch", runId, afterEventId: watch.lastEventId });

    options.fetchUnreadNotifications?.().catch((err: unknown) => {
      console.error("Sync client failed to fetch unread notifications after connect", err);
    });

    gateInvalidations = true;
    const refetch = options.refetchActiveState?.() ?? Promise.resolve();
    refetch
      .catch((err: unknown) => {
        // The active-state refetch itself failed: logged, not swallowed, and the gate still
        // lifts below rather than leaving this client permanently deaf to invalidations over one
        // failed fetch — the next write still arrives as a live `invalidate` frame even though
        // this particular resync attempt didn't converge.
        console.error("Sync client failed to refetch active state after connect", err);
      })
      .finally(() => {
        gateInvalidations = false;
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
    const ws = options.createSocket();
    socket = ws;
    ws.onopen = () => {
      reconnectAttempt = 0;
      recoverAfterConnect();
    };
    ws.onmessage = (event) => handleMessage(event.data);
    // A listener must be attached even when the caller supplies none: leaving `onerror` null
    // would surface as an unhandled error in some `WebSocketLike` implementations (`ws`'s own
    // included) rather than the `close` event this client already reacts to right after.
    ws.onerror = (err: unknown) => {
      console.error("Sync client socket error", err);
    };
    ws.onclose = (event) => {
      socket = null;
      if (event.code === SESSION_REVOKED_CLOSE_CODE) {
        // Terminal: a revoked session will fail authentication again on every retry, so this
        // client stops rather than looping against a credential that will never become valid.
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
      if (!openDocs.delete(docId)) return;
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
